"""GPT-Live demo server.

- POST /api/session : WebRTC. Relays the browser's SDP offer to {BASE_URL}/live/sessions and returns the answer.
- WS   /live        : WebSocket relay. Opens {BASE_URL}/live/sessions with the key and pipes events both ways.
The API key is read from .env and never leaves this process.
"""

import asyncio
import json
import os
import re
from pathlib import Path

from fastapi import Request, WebSocket, WebSocketDisconnect
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, ConnectionClosedError, InvalidStatus
from websockets.protocol import State

from demokit import (
    Upstream, UpstreamError, auth_headers, create_app, dig, key_missing, load_env, origin, parse_url, read_json,
    reply, safe_host, serve, upstream_message, with_hint,
)

ROOT = Path(__file__).resolve().parent
env = load_env(__file__)

# ───────────────────────── config ─────────────────────────


def normalize_base_url(raw: str) -> str:
    """Accept whatever the portal shows and return the base the live API hangs off."""
    u = parse_url(raw)
    if not u:
        return ""
    path = u.path.rstrip("/")
    if re.search(r"\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$", u.hostname, re.I):
        if not re.search(r"/openai/v1$", path, re.I):
            path = "/openai/v1"  # also drops /api/projects/... from Foundry project URLs
    elif u.hostname == "api.openai.com" and not path:
        path = "/v1"
    return origin(u) + path


RAW_BASE_URL = env("BASE_URL") or env("AZURE_OPENAI_ENDPOINT")
BASE_URL = normalize_base_url(RAW_BASE_URL)
API_KEY = env("API_KEY") or env("AZURE_OPENAI_API_KEY")
MODEL = env("GPT_LIVE_MODEL", "gpt-live-1")
VOICE = env("GPT_LIVE_VOICE", "marin")
DELEGATION_MODEL = env("DELEGATION_MODEL")
REASONING_EFFORT = env("DELEGATION_REASONING_EFFORT")
WEB_SEARCH = env.flag("ENABLE_WEB_SEARCH")
AUTH = auth_headers(env("AUTH_HEADER", "auto").lower(), API_KEY, BASE_URL)
PORT = int(env.number("PORT", 3000)) or 3000
DEBUG = env.flag("DEBUG")
HUB_URL = os.environ.get("DEMOBOX_HUB_URL") or "http://localhost:8000"

DEFAULT_INSTRUCTIONS = " ".join([
    "You are a warm, concise voice assistant in a live product demo.",
    "Speak naturally in short sentences and reply in the language the user speaks.",
    "When you need facts, the current time, the weather, or anything you are unsure of, delegate to your backend instead of guessing.",
])

BACKEND_INSTRUCTIONS = " ".join([
    "You are the reasoning backend for a live voice assistant.",
    "Your answer is spoken aloud by the voice model, so reply in one to three short, plain sentences:",
    "no markdown, lists, tables, or URLs.",
    "Use the tools when they help. Reply in the language the user is speaking.",
])

# Function tools run in the browser (see public/app.js → TOOL_HANDLERS). Keep names in sync.
FUNCTION_TOOLS = [
    {
        "type": "function",
        "name": "get_current_time",
        "description": "Get the current local date and time in a timezone.",
        "parameters": {
            "type": "object",
            "properties": {
                "timezone": {"type": "string", "description": "IANA timezone name, for example Asia/Shanghai or America/Seattle."},
            },
            "required": ["timezone"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City name in English, for example Shanghai or Singapore."},
            },
            "required": ["location"],
            "additionalProperties": False,
        },
    },
]


def config_problems() -> list[str]:
    problems = []
    if not RAW_BASE_URL:
        problems.append("BASE_URL is empty")
    elif not BASE_URL:
        problems.append(f"BASE_URL is not a valid URL ({RAW_BASE_URL})")
    if key_missing(API_KEY):
        problems.append("API_KEY is empty")
    return problems


# ───────────────────────── session ─────────────────────────


def build_session(voice=None, instructions=None) -> dict:
    """The session the live API opens, from the voice and instructions picked on the page."""
    custom = instructions.strip()[:6000] if isinstance(instructions, str) else ""
    session = {
        "model": MODEL,
        "instructions": custom or DEFAULT_INSTRUCTIONS,
        "audio": {"output": {"voice": voice if isinstance(voice, str) and re.fullmatch(r"[\w-]{1,40}", voice) else VOICE}},
    }
    if DELEGATION_MODEL:
        responses = {
            "model": DELEGATION_MODEL,
            "instructions": BACKEND_INSTRUCTIONS,
            "tools": ([{"type": "web_search"}] if WEB_SEARCH else []) + FUNCTION_TOOLS,
            "tool_choice": "auto",
            "parallel_tool_calls": True,
        }
        if REASONING_EFFORT:
            responses["reasoning"] = {"effort": REASONING_EFFORT}
        session["delegation"] = {"type": "responses", "responses": responses}
    else:
        session["delegation"] = {"type": "client"}
    return session


def upstream_error(status: int, data, text: str) -> str:
    msg = upstream_message(status, data, text)
    if status in (401, 403):
        hint = " Check API_KEY (and AUTH_HEADER) in .env."
    elif status == 404:
        hint = f' Check BASE_URL and that "{MODEL}" is deployed in that resource (GPT_LIVE_MODEL).'
    elif status == 400 and re.search(r"valid deployment", msg, re.I):
        also = f' and "{DELEGATION_MODEL}" (DELEGATION_MODEL)' if DELEGATION_MODEL else ""
        hint = f' Check that "{MODEL}" (GPT_LIVE_MODEL){also} are deployment names in that resource.'
    else:
        hint = ""
    return with_hint(msg, hint)


# ───────────────────────── http ─────────────────────────

app = create_app()
upstream = Upstream(timeout=60)


@app.get("/api/config")
async def get_config():
    problems = config_problems()
    delegation = (
        {"type": "responses", "model": DELEGATION_MODEL, "webSearch": WEB_SEARCH, "tools": [t["name"] for t in FUNCTION_TOOLS]}
        if DELEGATION_MODEL else {"type": "client"}
    )
    return reply({
        "ready": not problems,
        "problems": problems,
        "host": safe_host(BASE_URL) or None,
        "baseUrl": BASE_URL or None,
        "model": MODEL,
        "voice": VOICE,
        "delegation": delegation,
        "defaultInstructions": DEFAULT_INSTRUCTIONS,
        "hubUrl": HUB_URL,
    })


@app.post("/api/session")
async def create_webrtc_session(request: Request):
    problems = config_problems()
    if problems:
        return reply({"error": "; ".join(problems)}, 500)
    body = await read_json(request) or {}
    if not body.get("sdp"):
        return reply({"error": "Missing SDP offer"}, 400)

    payload = {
        "session": build_session(body.get("voice"), body.get("instructions")),  # no audio.format: WebRTC negotiates it through SDP
        "transport": {"type": "webrtc", "sdp": body["sdp"]},
    }
    target = f"{BASE_URL}/live/sessions"
    session = payload["session"]
    print(f"[webrtc] POST {target}  model={MODEL} voice={session['audio']['output']['voice']} delegation={session['delegation']['type']}")

    try:
        r = await upstream.send(target, "POST", {**AUTH, "Content-Type": "application/json"}, payload)
    except UpstreamError as exc:
        return reply({"error": f"Could not reach {safe_host(BASE_URL)}: {exc}"}, 502)

    data = r.data
    if not r.ok:
        message = upstream_error(r.status, data, r.text)
        print(f"[webrtc] {r.status} {message}")
        return reply({"error": message, "status": r.status, "detail": data if data is not None else r.text[:2000]}, r.status)

    is_sdp = "application/sdp" in r.headers.get("content-type", "") or r.text.startswith("v=0")
    answer = dig(data, "transport", "sdp") or dig(data, "sdp") or (r.text if is_sdp else None)
    if not answer:
        return reply({"error": "The service answered without an SDP answer", "detail": data if data is not None else r.text[:2000]}, 502)

    print(f"[webrtc] session created {dig(data, 'session', 'id') or ''}")
    return reply({"sdp": answer, "session": dig(data, "session")})


# ───────────────────────── websocket relay ─────────────────────────


@app.websocket("/live")
async def live(browser: WebSocket):
    await browser.accept()
    start = await wait_for_start(browser)
    if start is None:
        return

    problems = config_problems()
    if problems:
        await to_browser(browser, {"type": "demo.error", "message": "; ".join(problems)})
        await close(browser, 1011, "Server not configured")
        return

    target = re.sub(r"^http", "ws", BASE_URL, flags=re.I) + "/live/sessions"
    session = build_session(start.get("voice"), start.get("instructions"))
    print(f"[ws] connecting {target}  model={MODEL} voice={session['audio']['output']['voice']} delegation={session['delegation']['type']}")

    try:
        service = await connect(target, additional_headers=AUTH, compression=None, max_size=None, close_timeout=1)
    except InvalidStatus as exc:
        status, text = exc.response.status_code, exc.response.body.decode(errors="replace")
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        message = upstream_error(status, data, text)
        print(f"[ws] handshake {status} {message}")
        await to_browser(browser, {"type": "demo.error", "status": status, "message": message})
        await close(browser, 1011, "Upstream refused the connection")
        return
    except Exception as exc:  # DNS, refused, TLS, a timeout, or not a WebSocket server
        print(f"[ws] upstream error {exc}")
        await to_browser(browser, {"type": "demo.error", "message": f"Connection to {safe_host(BASE_URL)} failed: {exc}"})
        await to_browser(browser, {"type": "demo.upstream_closed", "code": 1006, "reason": ""})
        await close(browser, 1000, "Upstream closed")
        return

    try:
        await relay(browser, service, session)
    finally:
        await service.close()


async def wait_for_start(browser: WebSocket) -> dict | None:
    """The first message carries the page's choices: { type: 'demo.start', voice, instructions }."""
    while True:
        msg = await browser.receive()
        if msg["type"] == "websocket.disconnect":
            return None
        try:
            start = json.loads(msg.get("text") or "")
        except ValueError:
            start = None
        if isinstance(start, dict) and start.get("type") == "demo.start":
            return start
        await to_browser(browser, {"type": "demo.error", "message": "Expected demo.start first"})


async def relay(browser: WebSocket, service: ClientConnection, session: dict) -> None:
    """Pipes events both ways until one side leaves, then closes the other the way the live API expects."""
    session_closed = False
    await service.send(json.dumps({"type": "session.start", "event_id": "evt_session_start", "session": session}))

    async def from_browser() -> None:
        while True:
            msg = await browser.receive()
            if msg["type"] == "websocket.disconnect":
                return
            data = msg["text"] if msg.get("text") is not None else msg.get("bytes")
            if data is None:
                continue
            try:
                await service.send(data)
            except ConnectionClosed:
                await asyncio.Future()  # the service left; from_service reports it

    async def from_service() -> None:
        nonlocal session_closed
        try:
            async for data in service:
                text = data if isinstance(data, str) else None
                if DEBUG and text and '"session.output_audio.delta"' not in text:
                    print("[ws] ←", text[:500])
                elif text and '"session.started"' in text:
                    print("[ws] session started")
                if text and '"session.closed"' in text:
                    session_closed = True
                await forward(browser, data)
        except ConnectionClosedError as exc:
            if exc.rcvd is None:  # dropped without a close frame: a network error
                print(f"[ws] upstream error {exc}")
                await to_browser(browser, {"type": "demo.error", "message": f"Connection to {safe_host(BASE_URL)} failed: {exc}"})

    browser_side = asyncio.create_task(from_browser())
    service_side = asyncio.create_task(from_service())
    await asyncio.wait([browser_side, service_side], return_when=asyncio.FIRST_COMPLETED)

    if service_side.done():
        code, reason = service.close_code or 1006, service.close_reason or ""
        print(f"[ws] upstream closed {code} {reason}")
        await to_browser(browser, {"type": "demo.upstream_closed", "code": code, "reason": reason})
        await close(browser, 1000, "Upstream closed")
    elif service.state is State.OPEN and not session_closed:
        # The browser left mid-session: ask the service to end it, and give it 3 seconds to do so.
        try:
            await service.send(json.dumps({"type": "session.close"}))
            await asyncio.wait_for(asyncio.shield(service_side), 3)
        except (ConnectionClosed, asyncio.TimeoutError):
            pass
    browser_side.cancel()
    service_side.cancel()


async def forward(browser: WebSocket, data) -> None:
    try:
        if isinstance(data, str):
            await browser.send_text(data)
        else:
            await browser.send_bytes(data)
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass  # the browser already left; keep reading so the service can close cleanly


async def to_browser(browser: WebSocket, obj: dict) -> None:
    await forward(browser, json.dumps(obj))


async def close(browser: WebSocket, code: int, reason: str) -> None:
    try:
        await browser.close(code, reason)
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass  # the browser already left


# ───────────────────────── start ─────────────────────────

if __name__ == "__main__":
    problems = config_problems()
    key = f"set ({'api-key header' if 'api-key' in AUTH else 'Bearer'})" if API_KEY else "(not set)"
    backend = (
        f"{DELEGATION_MODEL} (responses delegation{', web_search' if WEB_SEARCH else ''})"
        if DELEGATION_MODEL else "none (client delegation)"
    )
    serve(app, PORT, ROOT / "public", [
        "GPT-Live demo",
        f"▸ Open      http://localhost:{PORT}",
        f"▸ Endpoint  {BASE_URL or '(not set)'}",
        f"▸ Key       {key}",
        f"▸ Model     {MODEL}   voice {VOICE}",
        f"▸ Backend   {backend}",
        *(f"⚠ {p} in {ROOT / '.env'}" for p in problems),
    ])
