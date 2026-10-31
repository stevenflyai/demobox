"""The FastAPI skeleton every DemoBox server shares: JSON errors, the static page, and a clear message for a busy port."""

import errno
import json
import socket
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException


def reply(obj, status: int = 200) -> JSONResponse:
    return JSONResponse(obj, status, headers={"Cache-Control": "no-store"})


def create_app(**kwargs) -> FastAPI:
    """A FastAPI app whose errors are {"error": message}, like every route's own failures."""
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, **kwargs)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return reply({"error": exc.detail}, exc.status_code)

    @app.exception_handler(Exception)
    async def crash(request: Request, exc: Exception):
        return reply({"error": str(exc) or type(exc).__name__}, 500)

    return app


async def read_json(request: Request, limit: int = 1_000_000) -> dict | None:
    """The request body as a JSON object, or None when it is anything else."""
    if int(request.headers.get("content-length") or 0) > limit:
        raise ValueError("Request body too large")
    body = await request.body()
    if len(body) > limit:
        raise ValueError("Request body too large")
    try:
        data = json.loads(body or b"{}")
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


class _Page(StaticFiles):
    """The page's files, revalidated on every load so an edited file shows on refresh."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


def _bind(host: str, port: int) -> socket.socket:
    if host or not socket.has_dualstack_ipv6():
        return socket.create_server((host or "0.0.0.0", port))
    return socket.create_server(("::", port), family=socket.AF_INET6, dualstack_ipv6=True)


def serve(app: FastAPI, port: int, public_dir: Path, banner: list[str], *, host: str = "",
          name: str = "The demo", port_setting: str = "set PORT in .env") -> None:
    """Serves public_dir at / behind the API routes, prints the banner, and runs until Ctrl-C."""
    sys.stdout.reconfigure(line_buffering=True)  # log lines reach a pipe or file as they happen
    app.mount("/", _Page(directory=public_dir, html=True), name="page")  # last, so API routes match first
    try:
        sock = _bind(host, port)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        print(f"\n  Port {port} is already in use. {name} may already be running at http://localhost:{port}", file=sys.stderr)
        print(f"  Stop the other process, or {port_setting} to use a different port.\n", file=sys.stderr)
        sys.exit(1)
    print("\n" + "\n".join(f"  {line}" for line in banner) + "\n", flush=True)
    config = uvicorn.Config(app, log_level="warning", ws_per_message_deflate=False, timeout_graceful_shutdown=3)
    uvicorn.Server(config).run(sockets=[sock])
