"""Shared plumbing for the DemoBox servers: .env settings, the FastAPI skeleton, and timed calls to the services."""

from .config import Env, dig, key_missing, load_env, num, truthy
from .upstream import (
    Reply,
    Upstream,
    UpstreamError,
    auth_headers,
    is_azure_host,
    origin,
    parse_url,
    safe_host,
    upstream_message,
    with_hint,
)
from .web import create_app, read_json, reply, serve

__all__ = [
    "Env", "Reply", "Upstream", "UpstreamError", "auth_headers", "create_app", "dig", "is_azure_host", "key_missing",
    "load_env", "num", "origin", "parse_url", "read_json", "reply", "safe_host", "serve", "truthy", "upstream_message",
    "with_hint",
]
