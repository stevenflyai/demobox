"""DemoBox hub.

- GET  /api/demos            : every demo in ../demos.json with its port and live status
- POST /api/demos/{id}/start : runs the demo's server.py with this same Python
- POST /api/demos/{id}/stop  : stops a demo this hub started
Run `python hub/server.py --all` to start every demo on launch. Listens on localhost only.
"""

import asyncio
import atexit
import json
import os
import re
import signal
import subprocess
import sys
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from fastapi import Request

from demokit import create_app, reply, serve

HUB_DIR = Path(__file__).resolve().parent
ROOT = HUB_DIR.parent
REGISTRY = ROOT / "demos.json"

PORT = int(os.environ.get("HUB_PORT") or 8000)
HOST = "127.0.0.1"
IS_WINDOWS = sys.platform == "win32"
# Each demo gets its own process group, so stopping it also ends anything it started.
NEW_GROUP = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if IS_WINDOWS else {"start_new_session": True}


@dataclass
class Child:
    proc: asyncio.subprocess.Process | None
    phase: str = "starting"  # starting | running | exited
    log: deque = field(default_factory=lambda: deque(maxlen=200))
    exit_code: int | None = None
    watcher: asyncio.Task | None = None


children: dict[str, Child] = {}

# ───────────────────────── registry ─────────────────────────


def load_demos() -> list[dict]:
    demos = json.loads(REGISTRY.read_text(encoding="utf-8"))
    for d in demos:
        d["path"] = ROOT / d["dir"]
        d["port"] = demo_port(d["path"], d["defaultPort"])
    return demos


def demo_port(folder: Path, fallback: int) -> int:
    """The demo's own .env decides its port; fall back to the registry default."""
    for name in (".env", ".env.example"):
        file = folder / name
        if file.is_file():
            m = re.search(r"^\s*PORT\s*=\s*['\"]?(\d+)", file.read_text(encoding="utf-8"), re.M)
            if m:
                return int(m[1])
    return fallback


# A proxy from the environment must never see localhost probes.
probe_client = httpx.AsyncClient(timeout=1.2, trust_env=False)


async def probe(port: int) -> dict:
    """Every demo serves GET /api/config with { ready, problems }. Anything else on the port is "something else"."""
    try:
        r = await probe_client.get(f"http://{HOST}:{port}/api/config")
    except httpx.TimeoutException:
        return {"running": True, "foreign": True}
    except httpx.HTTPError:
        return {"running": False}
    try:
        data = r.json()
    except ValueError:
        data = None
    if isinstance(data, dict) and isinstance(data.get("ready"), bool):
        return {"running": True, "ready": data["ready"], "problems": data.get("problems") or []}
    return {"running": True, "foreign": True}


async def demo_status(d: dict) -> dict:
    child = children.get(d["id"])
    live = await probe(d["port"])
    return {
        "id": d["id"],
        "name": d["name"],
        "tagline": d.get("tagline"),
        "description": d.get("description"),
        "tags": d.get("tags") or [],
        "i18n": d.get("i18n") or {},
        "dir": d["dir"],
        "port": d["port"],
        "url": f"http://localhost:{d['port']}",
        **live,
        "managed": bool(child and child.phase != "exited"),
        "phase": child.phase if child else None,
        "exitCode": child.exit_code if child else None,
        "log": list(child.log)[-40:] if child else [],
    }


# ───────────────────────── process control ─────────────────────────


async def start_demo(d: dict) -> dict:
    existing = children.get(d["id"])
    if existing and existing.phase != "exited":
        return {"ok": True}
    if (await probe(d["port"]))["running"]:
        return {"ok": False, "error": f"Port {d['port']} is already in use"}

    env = {**os.environ, "DEMOBOX_HUB_URL": f"http://localhost:{PORT}", "PYTHONUNBUFFERED": "1"}
    env.pop("PORT", None)  # each demo reads its own PORT from its .env
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "server.py", cwd=d["path"], env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, limit=1 << 20, **NEW_GROUP,
        )
    except OSError as exc:
        children[d["id"]] = Child(None, "exited", deque([str(exc)]), 1)
        return {"ok": False, "error": str(exc)}
    child = children[d["id"]] = Child(proc)
    child.watcher = asyncio.create_task(watch(d["id"], child))
    return {"ok": True}


async def watch(demo_id: str, child: Child) -> None:
    """Keeps the last lines of output, marks the demo running once it prints its URL, and records the exit."""
    async for raw in child.proc.stdout:
        line = raw.decode(errors="replace").rstrip()
        if not line.strip():
            continue
        child.log.append(line)
        print(f"[{demo_id}] {line}", flush=True)
        if child.phase == "starting" and re.search(r"localhost:\d+", line):
            child.phase = "running"
    code = await child.proc.wait()
    child.exit_code = max(code, 0)  # negative means stopped by a signal, which is how Stop ends it
    child.phase = "exited"


def stop_demo(demo_id: str) -> bool:
    child = children.get(demo_id)
    if not child or not child.proc or child.phase == "exited":
        return False
    try:
        if IS_WINDOWS:
            subprocess.Popen(["taskkill", "/pid", str(child.proc.pid), "/T", "/F"])
        else:
            os.killpg(child.proc.pid, signal.SIGTERM)
    except OSError:
        pass  # already gone
    return True


def stop_all() -> None:
    for demo_id in list(children):
        stop_demo(demo_id)


atexit.register(stop_all)


async def start_all() -> None:
    for d in load_demos():
        r = await start_demo(d)
        if not r["ok"]:
            print(f"[{d['id']}] not started: {r['error']}", flush=True)


# ───────────────────────── http ─────────────────────────

background: set[asyncio.Task] = set()


@asynccontextmanager
async def lifespan(app):
    if "--all" in sys.argv:
        task = asyncio.create_task(start_all())
        background.add(task)
        task.add_done_callback(background.discard)
    yield
    stop_all()


app = create_app(lifespan=lifespan)


@app.get("/api/demos")
async def list_demos():
    demos = load_demos()
    return reply({"demos": await asyncio.gather(*(demo_status(d) for d in demos))})


@app.post("/api/demos/{demo_id}/{action}")
async def control(demo_id: str, action: str, request: Request):
    if action not in ("start", "stop"):
        return reply({"error": "Not Found"}, 404)
    if not same_origin(request):
        return reply({"error": "Cross-origin request refused"}, 403)
    d = next((x for x in load_demos() if x["id"] == demo_id), None)
    if not d:
        return reply({"error": "Unknown demo"}, 404)
    if action == "start":
        return reply(await start_demo(d))
    return reply({"ok": stop_demo(d["id"])})


def same_origin(request: Request) -> bool:
    """Only the hub page itself may start or stop processes."""
    origin = request.headers.get("origin")
    return not origin or origin in (f"http://localhost:{PORT}", f"http://{HOST}:{PORT}")


# ───────────────────────── start ─────────────────────────

if __name__ == "__main__":
    banner = ["DemoBox hub", f"▸ Open      http://localhost:{PORT}"]
    banner += [f"▸ {d['name']:<18} http://localhost:{d['port']}   ({d['dir']}/)" for d in load_demos()]
    serve(app, PORT, HUB_DIR / "public", banner, host=HOST, name="The hub", port_setting="set HUB_PORT")
