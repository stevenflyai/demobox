"""Calls to the AI services: a keep-alive pool timed by phase, plus the URL, auth, and error rules the demos share."""

import json
import re
import time
from dataclasses import dataclass, field
from functools import cached_property
from urllib.parse import SplitResult, urlsplit

import httpx

from .config import dig

_SCHEMES = {"http": 80, "https": 443, "ws": 80, "wss": 443}


def parse_url(raw) -> SplitResult | None:
    """The parts of an absolute http(s) or ws(s) URL, or None when raw isn't one."""
    if not isinstance(raw, str):
        return None
    try:
        u = urlsplit(raw.strip())
        u.port  # raises ValueError for a malformed port
    except ValueError:
        return None
    return u if u.scheme.lower() in _SCHEMES and u.hostname else None


def _host(u: SplitResult) -> str:
    host = f"[{u.hostname}]" if ":" in u.hostname else u.hostname
    return host if u.port in (None, _SCHEMES[u.scheme.lower()]) else f"{host}:{u.port}"


def safe_host(url) -> str:
    """host[:port] as a browser shows it, or '' when url isn't a URL."""
    u = parse_url(url)
    return _host(u) if u else ""


def origin(u: SplitResult) -> str:
    return f"{u.scheme.lower()}://{_host(u)}"


def is_azure_host(host: str) -> bool:
    return bool(re.search(r"\.(azure\.com|azure-api\.net|azure\.cn)$", host, re.I))


def auth_headers(mode: str, api_key: str, endpoint: str) -> dict:
    """The api-key header for Azure hosts and Bearer elsewhere, unless *_AUTH_HEADER picks one."""
    if mode not in ("api-key", "bearer"):
        mode = "api-key" if is_azure_host(safe_host(endpoint)) else "bearer"
    return {"api-key": api_key} if mode == "api-key" else {"Authorization": f"Bearer {api_key}"}


def upstream_message(status: int, data, text: str) -> str:
    """The service's own error message, from whichever field it puts it in."""
    error = dig(data, "error")
    detail = dig(data, "detail")
    if isinstance(detail, list):  # FastAPI-style validation errors
        detail = "; ".join(
            f"{'.'.join(map(str, d['loc']))}: {d['msg']}" if d.get("loc") else str(d["msg"])
            for d in detail if isinstance(d, dict) and d.get("msg")
        )
    msg = (
        dig(error, "message") or dig(data, "userMessage") or dig(data, "message")
        or (error if isinstance(error, str) else "") or (detail if isinstance(detail, str) else "")
        or (text or "")[:400] or f"HTTP {status}"
    )
    return str(msg)


def with_hint(msg: str, hint: str) -> str:
    """Appends a hint that names the .env variable to check."""
    trailing = ". \t\r\n"
    return f"{msg.rstrip(trailing)}.{hint}" if hint else msg


class UpstreamError(Exception):
    """The service could not be reached: DNS, connect, TLS, or a timeout. The message says which."""


@dataclass
class Reply:
    status: int
    text: str
    timing: dict
    headers: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @cached_property
    def data(self):
        """The body as JSON, or None when it isn't JSON."""
        try:
            return json.loads(self.text)
        except ValueError:
            return None


def _ms(seconds: float) -> int:
    return int(seconds * 1000 + 0.5)


class Upstream:
    """One keep-alive pool per server, so a warm run measures the service rather than the TLS handshake.

    Each Reply carries its timing:
      connectMs    DNS + TCP + TLS, 0 when an open connection was reused
      responseMs   from connected to the last byte: upload, one round trip, service time, download
      roundTripMs  the last TCP connect to this host, about one network round trip
    """

    def __init__(self, timeout: float):
        self.timeout = timeout
        self.client = httpx.AsyncClient(timeout=timeout, limits=httpx.Limits(keepalive_expiry=60))
        self.round_trips: dict[str, int] = {}

    async def send(self, url: str, method: str = "GET", headers: dict | None = None, body=None, retry: bool = True) -> Reply:
        """Sends body as compact JSON (when given) and reads the whole response."""
        content = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        marks: dict[str, float] = {}

        async def trace(event: str, info: dict) -> None:
            marks.setdefault(event, time.perf_counter())

        t0 = time.perf_counter()
        try:
            r = await self.client.request(method, url, headers=headers, content=content, extensions={"trace": trace})
        except httpx.TimeoutException as exc:
            raise UpstreamError(f"timed out after {self.timeout:g}s") from exc
        except (httpx.RemoteProtocolError, httpx.ReadError, httpx.WriteError) as exc:
            # The service closed a pooled connection while it sat idle: retry once on a fresh one.
            if retry and "connection.connect_tcp.started" not in marks:
                return await self.send(url, method, headers, body, retry=False)
            raise UpstreamError(str(exc) or type(exc).__name__) from exc
        except httpx.HTTPError as exc:
            raise UpstreamError(str(exc) or type(exc).__name__) from exc
        end = time.perf_counter()

        host = safe_host(url)
        tcp_start = marks.get("connection.connect_tcp.started")
        tcp_done = marks.get("connection.connect_tcp.complete")
        reused = tcp_start is None
        if tcp_start is not None and tcp_done is not None:
            self.round_trips[host] = _ms(tcp_done - tcp_start)
        connected = t0 if reused else marks.get("connection.start_tls.complete") or tcp_done or t0
        return Reply(
            status=r.status_code,
            text=r.text,
            headers=dict(r.headers),
            timing={
                "reused": reused,
                "connectMs": _ms(connected - t0),
                "responseMs": _ms(end - connected),
                "totalMs": _ms(end - t0),
                "roundTripMs": self.round_trips.get(host),
            },
        )
