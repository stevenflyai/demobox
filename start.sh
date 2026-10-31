#!/usr/bin/env bash
# Start the DemoBox hub (http://localhost:8000, or $HUB_PORT).
#   ./start.sh          hub only; start demos from the page
#   ./start.sh --all    hub + every demo
#   ./start.sh --open   also open the hub in the browser once it's up
set -euo pipefail

cd "$(dirname "$0")"

ALL=""
OPEN=""
for arg in "$@"; do
  case "$arg" in
    --all) ALL="--all" ;;
    --open) OPEN=1 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

# With uv, `uv run` creates .venv and installs the dependencies on first use.
# Without it, use a Python 3.10+ where `pip install -e .` has been run.
if command -v uv >/dev/null 2>&1; then
  RUN=(uv run --quiet python)
elif [ -x .venv/bin/python ]; then
  RUN=(.venv/bin/python)
elif command -v python3 >/dev/null 2>&1; then
  RUN=(python3)
else
  echo "Python 3.10+ is required. Install uv (https://docs.astral.sh/uv/) or Python (https://www.python.org)." >&2
  exit 1
fi

if ! "${RUN[@]}" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  echo "Python 3.10+ is required (found $("${RUN[@]}" -V 2>&1))." >&2
  exit 1
fi
if ! "${RUN[@]}" -c 'import demokit, fastapi, uvicorn, httpx, websockets' 2>/dev/null; then
  echo "The dependencies are not installed. Run: uv sync   (or: python3 -m pip install -e .)" >&2
  exit 1
fi

PORT="${HUB_PORT:-8000}"
URL="http://localhost:$PORT"

if [ -n "$OPEN" ]; then
  # Wait for the hub to answer, then open it; gives up after ~15s.
  (
    for _ in $(seq 1 30); do
      if curl -fs -o /dev/null "$URL/api/demos"; then
        if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 || true; fi
        exit 0
      fi
      sleep 0.5
    done
  ) &
fi

# exec so Ctrl-C reaches the hub, which stops every demo it started.
exec "${RUN[@]}" hub/server.py $ALL
