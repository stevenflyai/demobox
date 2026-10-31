"""Settings from a demo's .env file (no python-dotenv), plus helpers for the loosely typed JSON the services return."""

import math
import os
import re
from pathlib import Path

_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def read_env_file(path: Path) -> None:
    """Copies KEY=value lines into os.environ. Variables already set in the environment win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        m = _LINE.match(line)
        if not m:
            continue
        value = m[2].strip()
        if re.fullmatch(r"(['\"]).*\1", value):
            value = value[1:-1]
        else:
            value = re.sub(r"\s+#.*$", "", value)
        os.environ.setdefault(m[1], value)


class Env:
    """env("KEY", "default") reads a trimmed setting; an empty value counts as unset."""

    def __call__(self, key: str, default: str = "") -> str:
        return (os.environ.get(key) or "").strip() or default

    def number(self, key: str, default: float) -> float:
        """A numeric setting; an unset or non-numeric value gives the default."""
        raw = self(key)
        value = num(raw) if raw else None
        return default if value is None else value

    def flag(self, key: str) -> bool:
        return truthy(self(key))


def load_env(server_file: str) -> Env:
    """Loads the .env next to a demo's server.py and returns the reader for it."""
    read_env_file(Path(server_file).resolve().parent / ".env")
    return Env()


def truthy(value: str) -> bool:
    return bool(re.fullmatch(r"1|true|yes|on", value or "", re.I))


def key_missing(key: str) -> bool:
    """True for an empty key or a placeholder left from .env.example."""
    return not key or bool(re.search(r"^<|your|xxx", key, re.I))


def num(value):
    """A finite number from a number or numeric string, else None (booleans are not numbers)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0
        try:
            value = float(text)
        except ValueError:
            return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    return None


def dig(value, *path):
    """value[a][b]..., or None as soon as a step is missing or the wrong type."""
    for key in path:
        if isinstance(value, dict):
            value = value.get(key)
        elif isinstance(value, list) and isinstance(key, int) and 0 <= key < len(value):
            value = value[key]
        else:
            return None
    return value
