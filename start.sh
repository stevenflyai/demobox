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

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18.17+ is required: https://nodejs.org" >&2
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=17)?0:1)'; then
  echo "Node.js 18.17+ is required (found $(node -v))." >&2
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
exec node hub/server.js $ALL
