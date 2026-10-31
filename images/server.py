"""Image models demo server.

- GET  /api/config     : which models (and the optional judge) are configured (never returns keys)
- POST /api/generate   : runs one model on { provider, prompt, aspect, size, quality, webGrounding } and returns
                         the image id, its measured latency, token usage and cost, and the raw request/response
- GET  /api/images/:id : the generated image (kept in memory for the last MAX_IMAGES runs)
- POST /api/judge      : asks a vision model whether an image meets each checklist item, and rates its quality
Keys are read from .env and never leave this process.
"""

import base64
import json
import os
import re
import struct
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from fastapi import Request, Response

from demokit import (
    Upstream, UpstreamError, auth_headers, create_app, dig, is_azure_host, key_missing, load_env, num, origin, parse_url,
    read_json, reply, safe_host, serve, upstream_message, with_hint,
)

ROOT = Path(__file__).resolve().parent
env = load_env(__file__)

# ───────────────────────── config ─────────────────────────

# Two wire protocols:
#   openai : { model, prompt, size: "WxH", quality, n }   → <base>/openai/v1/images/generations
#   mai    : { model, prompt, width, height, web_grounding } → <resource>.services.ai.azure.com/mai/v1/images/generations
# Both return { data: [{ b64_json }] }. The judge uses a third: the Responses API.


def resolve_endpoint(protocol: str, raw: str) -> str:
    """Accept whatever the portal shows (resource endpoint, project URL, or the full path) and return the POST URL."""
    u = parse_url(raw)
    if not u:
        return ""
    base = origin(u)
    path = u.path.rstrip("/")
    azure = is_azure_host(u.hostname)
    tail = "/responses" if protocol == "responses" else "/images/generations"
    # A full path is used as-is, but only for its own API: a pasted /openai/... URL never reaches a MAI model, and vice versa.
    is_mai_path = bool(re.search(r"/mai/", path, re.I))
    as_is = path.lower().endswith(tail) and (protocol == "mai") == is_mai_path

    if not as_is:
        if protocol == "mai":
            # MAI models are served only on the services.ai.azure.com name of the same resource.
            if azure:
                base = re.sub(r"\.(openai|cognitiveservices)\.azure\.com$", ".services.ai.azure.com", base, flags=re.I)
            path = f"/mai/v1{tail}" if azure else f"{re.sub(r'/(mai/)?v1$', '', path, flags=re.I)}/mai/v1{tail}"
        elif azure:
            path = f"/openai/v1{tail}"  # also drops /api/projects/... pasted from the portal
        else:
            path = f"{path}{tail}" if re.search(r"/v1$", path, re.I) else f"{path}/v1{tail}"
    return f"{base}{path}{'?' + u.query if u.query else ''}"


@dataclass
class Connection:
    """One model's endpoint and key. The *_var fields name the variable in use, so errors point at the right line."""

    env_prefix: str
    label: str
    protocol: str
    url_var: str
    key_var: str
    auth_var: str
    raw_base_url: str
    endpoint: str
    api_key: str
    model: str
    auth_header: str
    id: str = ""
    vendor: str = ""
    price: dict | None = None

    def problems(self) -> list[str]:
        problems = []
        if not self.raw_base_url:
            problems.append(f"{self.url_var} is empty")
        elif not self.endpoint:
            problems.append(f"{self.url_var} is not a valid URL ({self.raw_base_url})")
        if key_missing(self.api_key):
            problems.append(f"{self.key_var} is empty")
        if not self.model:
            problems.append(f"{self.env_prefix}_MODEL is empty")
        return problems

    def headers(self) -> dict:
        return {**auth_headers(self.auth_header, self.api_key, self.endpoint), "Content-Type": "application/json", "Accept": "application/json"}


def connection(prefix: str, group: str, protocol: str, label: str, model: str = "", **extra) -> Connection:
    """Each model reads its group's GPT_IMAGE_* or MAI_* settings; its own *_BASE_URL / *_API_KEY / *_AUTH_HEADER win."""
    pick = lambda suffix: f"{prefix}_{suffix}" if env(f"{prefix}_{suffix}") else f"{group}_{suffix}"  # noqa: E731
    url_var, key_var, auth_var = pick("BASE_URL"), pick("API_KEY"), pick("AUTH_HEADER")
    raw = env(url_var)
    return Connection(
        env_prefix=prefix, label=label, protocol=protocol, url_var=url_var, key_var=key_var, auth_var=auth_var,
        raw_base_url=raw, endpoint=resolve_endpoint(protocol, raw), api_key=env(key_var),
        model=env(f"{prefix}_MODEL", model), auth_header=env(auth_var, "auto").lower(), **extra,
    )


def model(id, label, vendor, protocol, group, prefix, default_model, price) -> Connection:
    """A generation model. Default prices are list prices in USD per 1M tokens (text input, image output) as of
    October 2026; set *_PRICE_INPUT_PER_1M / *_PRICE_OUTPUT_PER_1M to match your contract."""
    return connection(prefix, group, protocol, label, default_model, id=id, vendor=vendor, price={
        "input": env.number(f"{prefix}_PRICE_INPUT_PER_1M", price[0]),
        "output": env.number(f"{prefix}_PRICE_OUTPUT_PER_1M", price[1]),
    })


PROVIDERS = [
    model("flare", "GPT-Image-2.5 Flare", "Azure OpenAI", "openai", "GPT_IMAGE", "GPT_IMAGE_FLARE", "gpt-image-2.5-flare", (5, 30)),
    model("sunburst", "GPT-Image-2.5 Sunburst", "Azure OpenAI", "openai", "GPT_IMAGE", "GPT_IMAGE_SUNBURST", "gpt-image-2.5-sunburst", (5, 30)),
    model("mai", "MAI-Image-2.6", "Microsoft AI", "mai", "MAI", "MAI_IMAGE", "MAI-Image-2.6", (5, 38)),
    model("maiflash", "MAI-Image-2.6-Flash", "Microsoft AI", "mai", "MAI", "MAI_IMAGE_FLASH", "MAI-Image-2.6-Flash", (1.75, 19)),
]

# The judge is an Azure OpenAI deployment, so it shares the GPT-Image resource unless JUDGE_* says otherwise.
JUDGE = connection("JUDGE", "GPT_IMAGE", "responses", "Judge")
JUDGE_EFFORT = env("JUDGE_REASONING_EFFORT")

PORT = int(env.number("PORT", 3002)) or 3002
TIMEOUT = env.number("REQUEST_TIMEOUT_SECONDS", 180) or 180
DEBUG = env.flag("DEBUG")
HUB_URL = os.environ.get("DEMOBOX_HUB_URL") or "http://localhost:8000"

# Every aspect ratio maps to one pixel size that all four models accept, so they render the same number of
# pixels: GPT-Image needs edges in multiples of 16; MAI-Image-2.6 needs both edges ≥ 768 and at most
# 2,359,296 pixels. "large" sits right at the MAI limit.
SIZES = {
    "standard": {
        "1:1": [1024, 1024], "3:2": [1536, 1024], "2:3": [1024, 1536], "4:3": [1280, 960],
        "3:4": [960, 1280], "16:9": [1536, 864], "9:16": [864, 1536],
    },
    "large": {
        "1:1": [1536, 1536], "3:2": [1872, 1248], "2:3": [1248, 1872], "4:3": [1776, 1328],
        "3:4": [1328, 1776], "16:9": [2048, 1152], "9:16": [1152, 2048],
    },
}
QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"]  # GPT-Image only; MAI has no quality setting
MAX_PROMPT_CHARS = 32_000
MAX_CHECKS = 20

# Generated images, oldest first. Each is a few MB, so only the most recent ones are kept.
MAX_IMAGES = 48
images: OrderedDict[str, dict] = OrderedDict()  # id → { buf, mime, provider }

# ───────────────────────── generation ─────────────────────────


def build_request(p: Connection, body: dict) -> dict:
    width, height = SIZES[body["size"]][body["aspect"]]
    if p.protocol == "openai":
        return {"model": p.model, "prompt": body["prompt"], "size": f"{width}x{height}", "quality": body["quality"], "n": 1}
    request = {"model": p.model, "prompt": body["prompt"], "width": width, "height": height}
    if body["webGrounding"]:
        request["web_grounding"] = True
    return request


def validate_generate(body: dict | None) -> str | None:
    if not isinstance(body, dict):
        return "Request body must be JSON"
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return "The prompt is empty"
    if len(prompt) > MAX_PROMPT_CHARS:
        return f"The prompt is longer than {MAX_PROMPT_CHARS} characters"
    size, aspect, quality = body.get("size"), body.get("aspect"), body.get("quality")
    if not isinstance(size, str) or size not in SIZES:
        return f'Unknown size "{size}"'
    if not isinstance(aspect, str) or aspect not in SIZES[size]:
        return f'Unknown aspect ratio "{aspect}"'
    if quality not in QUALITIES:
        return f'Unknown quality "{quality}"'
    body["prompt"] = prompt.strip()
    body["webGrounding"] = body.get("webGrounding") is True
    return None


def normalize_usage(u) -> dict | None:
    """OpenAI: { input_tokens, output_tokens }. MAI: { num_input_text_tokens, num_input_image_tokens, num_output_tokens }."""
    if not isinstance(u, dict):
        return None
    first = lambda *keys: next((u[k] for k in keys if u.get(k) is not None), None)  # noqa: E731
    usage = {
        "input": num(first("input_tokens", "prompt_tokens", "num_input_text_tokens")),
        "output": num(first("output_tokens", "completion_tokens", "num_output_tokens")),
    }
    return None if usage["input"] is None and usage["output"] is None else usage


def redact_images(value):
    """Base64 images make the wire view unreadable; replace each with its size."""
    if isinstance(value, list):
        return [redact_images(v) for v in value]
    if not isinstance(value, dict):
        return value
    return {
        k: f"<base64 image, {format_bytes(len(v) * 0.75)}>" if k == "b64_json" and isinstance(v, str) else redact_images(v)
        for k, v in value.items()
    }


# ───────────────────────── judge ─────────────────────────

JUDGE_INSTRUCTIONS = "\n".join([
    "You grade an AI-generated image. You are given the prompt the image model received, a numbered list of requirements, and the image.",
    "For each requirement, decide whether the image clearly satisfies it. Be strict: if it is only partly met, ambiguous, or you cannot tell, it fails. For text in the image, the spelling must match exactly.",
    "Give a one-sentence reason per requirement that names what you see.",
    "Then rate the overall image quality from 1 to 10, ignoring the requirements: realism or stylistic coherence, anatomy and hands, legibility of any text, lighting, composition, and visible artifacts. 10 is flawless professional work.",
])

JUDGE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["checks", "quality", "quality_notes"],
    "properties": {
        "checks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["index", "pass", "reason"],
                "properties": {"index": {"type": "integer"}, "pass": {"type": "boolean"}, "reason": {"type": "string"}},
            },
        },
        "quality": {"type": "integer"},
        "quality_notes": {"type": "string"},
    },
}


def output_text(data) -> str:
    """The text of a Responses API reply."""
    if not isinstance(data, dict):
        return ""
    if isinstance(data.get("output_text"), str):
        return data["output_text"]
    for item in data.get("output") or []:
        for c in (item.get("content") or []) if isinstance(item, dict) else []:
            if isinstance(c, dict) and c.get("type") == "output_text" and isinstance(c.get("text"), str):
                return c["text"]
    return ""


# ───────────────────────── http ─────────────────────────

app = create_app()
upstream = Upstream(timeout=TIMEOUT)


@app.get("/api/config")
async def get_config():
    providers = [
        {
            "id": p.id, "label": p.label, "vendor": p.vendor, "protocol": p.protocol, "envPrefix": p.env_prefix,
            "model": p.model, "host": safe_host(p.endpoint) or None, "endpoint": p.endpoint or None, "price": p.price,
            "ready": not p.problems(), "problems": p.problems(),
        }
        for p in PROVIDERS
    ]
    ready = any(p["ready"] for p in providers)
    judge_problems = JUDGE.problems()
    return reply({
        "ready": ready,
        "problems": [] if ready else ["No model is configured in images/.env"],
        "providers": providers,
        "judge": {"ready": not judge_problems, "model": JUDGE.model or None, "host": safe_host(JUDGE.endpoint) or None, "problems": judge_problems},
        "sizes": SIZES,
        "qualities": QUALITIES,
        "hubUrl": HUB_URL,
    })


@app.post("/api/generate")
async def generate(request: Request):
    body = await read_json(request)
    p = next((x for x in PROVIDERS if body and x.id == body.get("provider")), None)
    if not p:
        return reply({"ok": False, "error": "Unknown model"}, 400)
    problems = p.problems()
    if problems:
        return reply({"ok": False, "provider": p.id, "notConfigured": True, "error": "; ".join(problems)})
    invalid = validate_generate(body)
    if invalid:
        return reply({"ok": False, "provider": p.id, "error": invalid}, 400)

    request_body = build_request(p, body)
    if DEBUG:
        print(f"[{p.id}] → POST {p.endpoint}\n{json.dumps(request_body, ensure_ascii=False)}")
    try:
        r = await upstream.send(p.endpoint, "POST", p.headers(), request_body)
    except UpstreamError as exc:
        print(f"[{p.id}] {exc}")
        return reply({"ok": False, "provider": p.id, "error": f"Could not reach {safe_host(p.endpoint)}: {exc}",
                      "endpoint": p.endpoint, "request": request_body})

    latency = r.timing["totalMs"]
    data = r.data
    response = redact_images(data) if data is not None else r.text[:4000]
    wire = {"endpoint": p.endpoint, "request": request_body, "response": response}
    if DEBUG:
        print(f"[{p.id}] ← {r.status} {latency}ms {json.dumps(response, ensure_ascii=False)[:1000]}")
    if not r.ok:
        error = upstream_error(p, r.status, data, r.text)
        print(f"[{p.id}] {r.status} {error}")
        return reply({"ok": False, "provider": p.id, "status": r.status, "latencyMs": latency, "timing": r.timing, "error": error, **wire})

    items = data.get("data") if isinstance(data, dict) else None
    first = next((d for d in items if isinstance(d, dict) and d.get("b64_json")), None) if isinstance(items, list) else None
    if not first:
        return reply({"ok": False, "provider": p.id, "status": r.status, "latencyMs": latency, "timing": r.timing,
                      "error": "The response has no image (data[].b64_json is missing)", **wire})

    buf = base64.b64decode(first["b64_json"])
    mime = sniff_mime(buf)
    dims = image_size(buf) or {}
    image_id = str(uuid.uuid4())
    images[image_id] = {"buf": buf, "mime": mime, "provider": p.id}
    while len(images) > MAX_IMAGES:
        images.popitem(last=False)

    usage = normalize_usage(data.get("usage"))
    cost = ((usage["input"] or 0) * p.price["input"] + (usage["output"] or 0) * p.price["output"]) / 1e6 if usage and p.price else None

    size = f"{dims['width']}x{dims['height']}" if dims else ""
    print(f"[{p.id}] {r.status} {latency}ms {size} {format_bytes(len(buf))}")
    return reply({
        "ok": True,
        "provider": p.id,
        "status": r.status,
        "latencyMs": latency,
        "timing": r.timing,
        "model": data.get("model") or p.model,
        "image": {"id": image_id, "url": f"/api/images/{image_id}", "mime": mime, "bytes": len(buf), **dims},
        "revisedPrompt": first["revised_prompt"] if isinstance(first.get("revised_prompt"), str) else None,
        "usage": usage,
        "cost": cost,
        **wire,
    })


@app.api_route("/api/images/{image_id}", methods=["GET", "HEAD"])
async def get_image(image_id: str):
    img = images.get(image_id)
    if not img:
        return reply({"error": "Image not found. Only the most recent images are kept."}, 404)
    return Response(img["buf"], media_type=img["mime"], headers={"Cache-Control": "private, max-age=86400, immutable"})


@app.post("/api/judge")
async def judge(request: Request):
    problems = JUDGE.problems()
    if problems:
        return reply({"ok": False, "notConfigured": True, "error": "; ".join(problems)})
    body = await read_json(request) or {}
    image_id = body.get("imageId")
    img = images.get(image_id) if isinstance(image_id, str) else None
    if not img:
        return reply({"ok": False, "error": "This image is no longer on the server. Generate it again."})
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return reply({"ok": False, "error": "The prompt is empty"}, 400)
    raw_checks = body.get("checks") if isinstance(body.get("checks"), list) else []
    checks = [c for c in raw_checks if isinstance(c, str) and c.strip()][:MAX_CHECKS]

    listed = "\n".join(f"{i + 1}. {c.strip()}" for i, c in enumerate(checks)) or "(none: return an empty checks array)"
    image_url = f"data:{img['mime']};base64,{base64.b64encode(img['buf']).decode()}"
    request_body = {
        "model": JUDGE.model,
        "instructions": JUDGE_INSTRUCTIONS,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": f'Prompt the image model received:\n"""\n{prompt.strip()}\n"""\n\nRequirements:\n{listed}'},
                {"type": "input_image", "image_url": image_url, "detail": "high"},
            ],
        }],
        "text": {"format": {"type": "json_schema", "name": "image_grade", "strict": True, "schema": JUDGE_SCHEMA}},
    }
    if JUDGE_EFFORT:
        request_body["reasoning"] = {"effort": JUDGE_EFFORT}

    try:
        r = await upstream.send(JUDGE.endpoint, "POST", JUDGE.headers(), request_body)
    except UpstreamError as exc:
        return reply({"ok": False, "error": f"Could not reach {safe_host(JUDGE.endpoint)}: {exc}"})
    data = r.data
    if DEBUG:
        print(f"[judge] ← {r.status} {r.timing['totalMs']}ms {r.text[:1000]}")
    if not r.ok:
        error = upstream_error(JUDGE, r.status, data, r.text)
        print(f"[judge] {r.status} {error}")
        return reply({"ok": False, "status": r.status, "error": error})

    try:
        grade = json.loads(output_text(data))
    except ValueError:
        grade = None
    if not isinstance(grade, dict) or not isinstance(grade.get("checks"), list):
        return reply({"ok": False, "error": "The judge did not return a grade"})

    def check(i: int):
        # The judge numbers requirements from 1; map back by position when the index is off.
        listed = grade["checks"]
        c = next((x for x in listed if isinstance(x, dict) and x.get("index") == i + 1), None)
        if c is None and i < len(listed):
            c = listed[i]
        if not isinstance(c, dict):
            return None
        return {"pass": c.get("pass") is True, "reason": str(c.get("reason") if c.get("reason") is not None else "")}

    quality = num(grade.get("quality"))
    print(f"[judge] {img['provider']} {r.timing['totalMs']}ms quality {grade.get('quality')}")
    return reply({
        "ok": True,
        "model": (data.get("model") if isinstance(data, dict) else None) or JUDGE.model,
        "latencyMs": r.timing["totalMs"],
        "checks": [check(i) for i in range(len(checks))],
        "quality": min(10, max(1, round_half_up(1 if quality is None else quality))),
        "notes": str(grade.get("quality_notes") if grade.get("quality_notes") is not None else ""),
    })


def upstream_error(c: Connection, status: int, data, text: str) -> str:
    msg = upstream_message(status, data, text)
    error = dig(data, "error")
    codes = " ".join(str(v) for v in (dig(error, "code"), dig(error, "type"), dig(error, "innererror", "code")) if v)
    if re.search(r"content_policy|content_filter|moderation|responsible ?ai|safety", f"{codes} {msg}", re.I):
        return with_hint(f"Blocked by the content filter: {msg}", " Rephrase the prompt.")
    if status in (401, 403):
        hint = f" Check {c.key_var} (and {c.auth_var}) in .env."
    elif status == 404:
        hint = f' Check {c.url_var}, and that "{c.model}" ({c.env_prefix}_MODEL) is a deployment in that resource. Calling {c.endpoint}.'
    elif status == 429:
        hint = " Rate limit reached. Wait a minute, use fewer runs, or raise the deployment quota."
    elif status in (400, 422) and re.search(r"model|deployment", msg, re.I):
        hint = f' Check that "{c.model}" ({c.env_prefix}_MODEL) is the right deployment name.'
    else:
        hint = ""
    return with_hint(msg, hint)


# ───────────────────────── helpers ─────────────────────────


def sniff_mime(buf: bytes) -> str:
    if buf[:2] == b"\x89P":
        return "image/png"
    if buf[:2] == b"\xff\xd8":
        return "image/jpeg"
    if buf[:4] == b"RIFF" and buf[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def image_size(buf: bytes) -> dict | None:
    """Width and height from the PNG header or the first JPEG frame, so the page shows what the model actually returned."""
    if buf[:1] == b"\x89" and len(buf) > 24:
        width, height = struct.unpack(">II", buf[16:24])
        return {"width": width, "height": height}
    if buf[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(buf):
            if buf[i] != 0xFF:
                return None
            marker = buf[i + 1]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">HH", buf[i + 5:i + 9])
                return {"width": width, "height": height}
            i += 2 + struct.unpack(">H", buf[i + 2:i + 4])[0]
    return None


def format_bytes(n: float) -> str:
    return f"{n / 1e6:.1f} MB" if n >= 1e6 else f"{round_half_up(n / 1e3)} KB"


def round_half_up(x: float) -> int:
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


# ───────────────────────── start ─────────────────────────

if __name__ == "__main__":
    lines = ["Image models demo", f"▸ Open      http://localhost:{PORT}"]
    for c in [*PROVIDERS, JUDGE]:
        problems = c.problems()
        lines.append(f"▸ {c.label:<23} {'⚠ ' + '; '.join(problems) if problems else f'{c.endpoint}  model {c.model}'}")
    serve(app, PORT, ROOT / "public", lines)
