"""Decision models demo server.

- GET  /api/config : which providers are configured (never returns keys)
- POST /api/decide : runs one provider on { provider, state, questions } and returns normalized answers,
                     latency with a connect/response breakdown, usage, and the raw request/response.
- POST /api/warm   : opens (or keeps open) one pooled connection per provider with a keyless GET,
                     so a run measures the model rather than the TLS handshake. Nothing is billed.
Keys are read from .env and never leave this process.
"""

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import Request

from demokit import (
    Upstream, UpstreamError, auth_headers, create_app, is_azure_host, key_missing, load_env, num, origin, parse_url,
    read_json, reply, safe_host, serve, upstream_message, with_hint,
)

ROOT = Path(__file__).resolve().parent
env = load_env(__file__)

# ───────────────────────── config ─────────────────────────

# Two wire protocols cover all three providers:
#   systemone : { model, state, questions: { name: { type: noul|choice|score, instructions, criteria } } }
#               used by Microsoft-Decision-1 (Foundry) and TypeSafe Jev
#   decisions : { model, input, questions: [ { type: predicate|choice|score, name, instructions, choices|levels } ] }
#               used by the OpenAI / Azure OpenAI Decisions API


def resolve_endpoint(protocol: str, raw: str) -> str:
    """Accept whatever the portal shows (resource endpoint, project URL, or the full path) and return the POST URL."""
    u = parse_url(raw)
    if not u:
        return ""
    path = u.path.rstrip("/")
    azure = is_azure_host(u.hostname)
    if protocol == "decisions":
        if not re.search(r"/decisions$", path, re.I):
            if azure:
                path = "/openai/v1/decisions"
            elif u.hostname == "api.openai.com":
                path = "/v1/decisions"
            else:
                path = f"{path}/decisions"
    elif not re.search(r"/systemone$", path, re.I):
        if azure:
            path = "/providers/microsoft/v1/systemone"  # also drops /openai/v1 or /api/projects/... pasted from the portal
        else:
            path = f"{path}/systemone" if re.search(r"/v1$", path, re.I) else f"{path}/v1/systemone"
    return origin(u) + path


@dataclass
class Provider:
    id: str
    label: str
    vendor: str
    protocol: str
    env_prefix: str
    raw_base_url: str
    endpoint: str
    api_key: str
    model: str
    auth_header: str
    price: dict  # list price in USD per 1M tokens, for the cost row

    def problems(self) -> list[str]:
        problems = []
        if not self.raw_base_url:
            problems.append(f"{self.env_prefix}_BASE_URL is empty")
        elif not self.endpoint:
            problems.append(f"{self.env_prefix}_BASE_URL is not a valid URL ({self.raw_base_url})")
        if key_missing(self.api_key):
            problems.append(f"{self.env_prefix}_API_KEY is empty")
        return problems

    def headers(self) -> dict:
        return {**auth_headers(self.auth_header, self.api_key, self.endpoint), "Content-Type": "application/json", "Accept": "application/json"}


def provider(id, label, vendor, protocol, prefix, model, base_url="", price=(0, 0)) -> Provider:
    """Reads one provider's *_BASE_URL, *_API_KEY, *_MODEL, *_AUTH_HEADER, and *_PRICE_* settings.

    Default prices are published list prices as of October 2026; set *_PRICE_INPUT_PER_1M /
    *_PRICE_OUTPUT_PER_1M to match your contract.
    """
    raw = env(f"{prefix}_BASE_URL", base_url)
    return Provider(
        id=id, label=label, vendor=vendor, protocol=protocol, env_prefix=prefix,
        raw_base_url=raw,
        endpoint=resolve_endpoint(protocol, raw),
        api_key=env(f"{prefix}_API_KEY"),
        model=env(f"{prefix}_MODEL", model),
        auth_header=env(f"{prefix}_AUTH_HEADER", "auto").lower(),
        price={
            "input": env.number(f"{prefix}_PRICE_INPUT_PER_1M", price[0]),
            "output": env.number(f"{prefix}_PRICE_OUTPUT_PER_1M", price[1]),
        },
    )


PROVIDERS = [
    provider("microsoft", "Microsoft-Decision-1", "Microsoft Foundry", "systemone", "MS_DECISION", "Microsoft-Decision-1", price=(0.042, 0)),
    provider("openai", "GPT Decisions API", "OpenAI / Azure OpenAI", "decisions", "GPT_DECISION", "gpt-6-luna", price=(0.10, 0)),
    provider("jev", "Jev", "TypeSafe", "systemone", "JEV", "jev-latest", "https://api.typesafe.ai", price=(0.042, 0)),
]

PORT = int(env.number("PORT", 3001)) or 3001
TIMEOUT = env.number("REQUEST_TIMEOUT_SECONDS", 30) or 30
DEBUG = env.flag("DEBUG")
HUB_URL = os.environ.get("DEMOBOX_HUB_URL") or "http://localhost:8000"

QUESTION_TYPES = {"yesno", "choice", "score"}
MAX_QUESTIONS = 20
MAX_STATE_CHARS = 60_000

# ───────────────────────── request mapping ─────────────────────────

# Canonical question (from the browser): { name, type: yesno|choice|score, instructions, options: [{ value, description }] }
# For choice, options are the labels to pick from. For score, options are the levels, lowest first.


def build_request(p: Provider, state, questions: list[dict]) -> dict:
    if p.protocol == "decisions":
        def question(q):
            if q["type"] == "yesno":
                return {"type": "predicate", "name": q["name"], "instructions": q["instructions"]}
            if q["type"] == "choice":
                choices = [{"value": o["value"], "description": o.get("description") or o["value"]} for o in q["options"]]
                return {"type": "choice", "name": q["name"], "instructions": q["instructions"], "choices": choices}
            levels = [{"label": o["value"], "description": o.get("description") or o["value"]} for o in q["options"]]
            return {"type": "score", "name": q["name"], "instructions": q["instructions"], "levels": levels}

        text = state if isinstance(state, str) else json.dumps(state, indent=2, ensure_ascii=False)
        return {"model": p.model, "input": text, "questions": [question(q) for q in questions]}

    out = {}
    for q in questions:
        if q["type"] == "yesno":
            out[q["name"]] = {"type": "noul", "instructions": q["instructions"]}
        elif q["type"] == "choice":
            criteria = {o["value"]: o.get("description") or o["value"] for o in q["options"]}
            out[q["name"]] = {"type": "choice", "instructions": q["instructions"], "criteria": criteria}
        else:
            # Score levels are a plain ordered list of strings; fold the description into the level text.
            criteria = [f"{o['value']}: {o['description']}" if o.get("description") else o["value"] for o in q["options"]]
            out[q["name"]] = {"type": "score", "instructions": q["instructions"], "criteria": criteria}
    return {"model": p.model, "state": state, "questions": out}


# ───────────────────────── response normalization ─────────────────────────

# Normalized answer: { name, kind: yesno|choice|score|refusal|missing,
#                      probability?, choice?, score?, confidence?, dist?: [{ label, p }] }  (dist in option order)


def normalize_answers(p: Provider, data, questions: list[dict]) -> list[dict]:
    answers = data.get("answers") if isinstance(data, dict) else None

    if p.protocol == "decisions":
        listed = answers if isinstance(answers, list) else []

        def dist(q, a):
            probs = [x for x in a.get("probabilities") or [] if isinstance(x, dict)] if isinstance(a.get("probabilities"), list) else []

            def matches(x, idx, o):
                if q["type"] == "score":
                    return same_number(x.get("value"), idx) or x.get("label") == o["value"]
                return as_text(x.get("value")) == o["value"]

            return [
                {"label": o["value"], "p": num(next((x.get("probability") for x in probs if matches(x, idx, o)), None))}
                for idx, o in enumerate(q["options"])
            ]

        def answer_for(i, q):
            found = next((x for x in listed if isinstance(x, dict) and x.get("name") == q["name"]), None)
            return found if found is not None else (listed[i] if i < len(listed) else None)

        return [normalize_one(q, answer_for(i, q), dist) for i, q in enumerate(questions)]

    by_name = answers if isinstance(answers, dict) else {}

    def dist(q, a):
        probs = a.get("probabilities")
        probs = {} if probs is None else probs

        def value(idx, o):
            # choice: keyed by value; score: keyed by level index ("0", "1", …). Arrays are accepted too.
            if isinstance(probs, list):
                hit = next((x for x in probs if isinstance(x, dict) and (
                    x.get("value") == o["value"] or same_number(x.get("value"), idx) or x.get("label") == o["value"])), None)
                found = hit.get("probability") if hit else None
                return found if found is not None else (probs[idx] if idx < len(probs) else None)
            if isinstance(probs, dict):
                return probs.get(str(idx)) if q["type"] == "score" else probs.get(o["value"])
            return None

        return [{"label": o["value"], "p": num(value(idx, o))} for idx, o in enumerate(q["options"])]

    return [normalize_one(q, by_name.get(q["name"]), dist) for q in questions]


def normalize_one(q: dict, a, read_dist) -> dict:
    if not isinstance(a, dict):
        return {"name": q["name"], "kind": "missing"}
    if a.get("type") == "refusal":
        return {"name": q["name"], "kind": "refusal"}
    confidence = num(a.get("confidence"))

    if q["type"] == "yesno":
        probability = next((a[k] for k in ("noul", "probability", "value") if a.get(k) is not None), None)
        return {"name": q["name"], "kind": "yesno", "probability": num(probability), "confidence": confidence}
    dist = read_dist(q, a)
    if q["type"] == "choice":
        choice = as_text(a["choice"]) if a.get("choice") is not None else None
        return {"name": q["name"], "kind": "choice", "choice": choice, "confidence": confidence, "dist": dist}
    score = num(a.get("score"))
    if score is None and all(d["p"] is not None for d in dist):
        score = sum(d["p"] * i for i, d in enumerate(dist))
    return {"name": q["name"], "kind": "score", "score": score, "confidence": confidence, "dist": dist}


def normalize_usage(u) -> dict | None:
    if not isinstance(u, dict):
        return None
    first = lambda *keys: next((u[k] for k in keys if u.get(k) is not None), None)  # noqa: E731
    return {"input": num(first("input_tokens", "prompt_tokens")), "output": num(first("output_tokens", "completion_tokens"))}


def same_number(value, n: int) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and value == n


def as_text(value) -> str:
    """How JavaScript's String() would print a JSON value, so "1" and 1 name the same option."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return "null" if value is None else str(value)


# ───────────────────────── validation ─────────────────────────


def validate_body(body: dict | None) -> str | None:
    if not isinstance(body, dict):
        return "Request body must be JSON"
    state, questions = body.get("state"), body.get("questions")
    if isinstance(state, str):
        if not state.strip():
            return "State is empty"
        if len(state) > MAX_STATE_CHARS:
            return f"State is longer than {MAX_STATE_CHARS} characters"
    elif not isinstance(state, (dict, list)):
        return "State must be text or a JSON object"
    if not isinstance(questions, list) or not questions:
        return "Add at least one question"
    if len(questions) > MAX_QUESTIONS:
        return f"At most {MAX_QUESTIONS} questions"

    names = set()
    for q in questions:
        if not isinstance(q, dict):
            return "Each question must be an object"
        name = q.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", name):
            return f'Question name "{name if name is not None else ""}" must start with a letter and use letters, digits, or _'
        if name in names:
            return f'Question name "{name}" is used twice'
        names.add(name)
        if q.get("type") not in QUESTION_TYPES:
            return f'Question "{name}" has an unknown type'
        if not isinstance(q.get("instructions"), str) or not q["instructions"].strip():
            return f'Question "{name}" needs instructions'
        if q["type"] == "yesno":
            q["options"] = []
            continue
        options = q.get("options")
        if not isinstance(options, list) or len(options) < 2:
            return f'Question "{name}" needs at least two {"levels" if q["type"] == "score" else "options"}'
        values = set()
        for o in options:
            value = o.get("value") if isinstance(o, dict) else None
            if not isinstance(value, str) or not value.strip():
                return f'Question "{name}" has an empty option'
            if value in values:
                return f'Question "{name}" lists "{value}" twice'
            values.add(value)
            if o.get("description") is not None and not isinstance(o["description"], str):
                return f'Question "{name}" has an invalid description'
    return None


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
    return reply({
        "ready": ready,
        "problems": [] if ready else ["No provider is configured in decision/.env"],
        "providers": providers,
        "hubUrl": HUB_URL,
    })


@app.post("/api/decide")
async def decide(request: Request):
    body = await read_json(request)
    p = next((x for x in PROVIDERS if body and x.id == body.get("provider")), None)
    if not p:
        return reply({"ok": False, "error": "Unknown provider"}, 400)
    problems = p.problems()
    if problems:
        return reply({"ok": False, "provider": p.id, "notConfigured": True, "error": "; ".join(problems)})
    invalid = validate_body(body)
    if invalid:
        return reply({"ok": False, "provider": p.id, "error": invalid}, 400)

    request_body = build_request(p, body["state"], body["questions"])
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
    raw = data if data is not None else r.text[:4000]
    if DEBUG:
        print(f"[{p.id}] ← {r.status} {latency}ms {r.text[:1000]}")
    if not r.ok:
        error = upstream_error(p, r.status, data, r.text)
        print(f"[{p.id}] {r.status} {error}")
        return reply({"ok": False, "provider": p.id, "status": r.status, "latencyMs": latency, "timing": r.timing,
                      "error": error, "endpoint": p.endpoint, "request": request_body, "response": raw})

    how = "warm" if r.timing["reused"] else f"connect {r.timing['connectMs']}ms"
    print(f"[{p.id}] {r.status} {latency}ms ({how}, response {r.timing['responseMs']}ms)")
    return reply({
        "ok": True,
        "provider": p.id,
        "status": r.status,
        "latencyMs": latency,
        "timing": r.timing,
        "model": (data.get("model") if isinstance(data, dict) else None) or p.model,
        "usage": normalize_usage(data.get("usage") if isinstance(data, dict) else None),
        "answers": normalize_answers(p, data, body["questions"]),
        "endpoint": p.endpoint,
        "request": request_body,
        "response": raw,
    })


@app.post("/api/warm")
async def warm():
    """A keyless GET on each endpoint: the provider rejects it (401/404/405) without running a model,
    but the pooled connection stays open for the next run."""

    async def ping(p: Provider) -> dict:
        try:
            r = await upstream.send(p.endpoint, headers={"Accept": "application/json"})
        except UpstreamError as exc:
            return {"id": p.id, "ok": False, "error": str(exc)}
        t = r.timing
        return {"id": p.id, "ok": True, "status": r.status, "reused": t["reused"], "ms": t["totalMs"], "roundTripMs": t["roundTripMs"]}

    ready = [p for p in PROVIDERS if not p.problems()]
    return reply({"providers": await asyncio.gather(*(ping(p) for p in ready))})


def upstream_error(p: Provider, status: int, data, text: str) -> str:
    msg = upstream_message(status, data, text)
    if status in (401, 403):
        hint = f" Check {p.env_prefix}_API_KEY (and {p.env_prefix}_AUTH_HEADER) in .env."
    elif status == 404:
        hint = f" Check {p.env_prefix}_BASE_URL. Calling {p.endpoint}."
    elif status == 422 or (status == 400 and re.search(r"model|deployment", msg, re.I)):
        hint = f' Check that "{p.model}" ({p.env_prefix}_MODEL) is the right model or deployment name.'
    else:
        hint = ""
    return with_hint(msg, hint)


# ───────────────────────── start ─────────────────────────

if __name__ == "__main__":
    lines = ["Decision models demo", f"▸ Open      http://localhost:{PORT}"]
    for p in PROVIDERS:
        problems = p.problems()
        lines.append(f"▸ {p.label:<21} {'⚠ ' + '; '.join(problems) if problems else f'{p.endpoint}  model {p.model}'}")
    serve(app, PORT, ROOT / "public", lines)
