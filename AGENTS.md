# AGENTS.md

Guidance for coding agents (and humans) working in this repo.

## What this is

**DemoBox** is a collection of small, self-contained browser demos of AI services, used for live customer and internal demos. Each demo is its own folder with its own Python server (FastAPI), `.env`, and README. A hub at the root lists the demos and can start, stop, and open them from one page.

The goal of every demo is to be **quick to set up and clear on stage**: fill in a key, run `uv run server.py`, open a localhost page that shows the service's distinctive behavior.

## Layout

```
demobox/
├── AGENTS.md          this file
├── README.md          project overview and quick start (English); README.zh-CN.md is the Chinese version
├── .gitignore         .env and variants (keeps .env.example), .venv, caches, logs, OS/editor and tool state; each demo has a copy
├── pyproject.toml     dependencies for every server (fastapi, uvicorn, httpx, websockets), pytest config; installs demokit
├── start.sh           Python check, then the hub (--all, --open)
├── demos.json         registry the hub reads: id, name, tagline, description, dir, defaultPort, tags
├── src/demokit/       code every server shares (src/ layout: only this package is importable, never the demo folders)
│   ├── config.py      load_env (the demo's .env → env("KEY", default)), num, dig, key_missing
│   ├── web.py         create_app (FastAPI with {"error"} responses), read_json, reply, serve (static page, busy-port message)
│   └── upstream.py    Upstream (keep-alive pool timed by phase), auth_headers, parse_url/safe_host/origin, upstream_message, with_hint
├── hub/               unified launcher UI
│   ├── server.py      GET /api/demos, POST /api/demos/{id}/start|stop (localhost only); runs each demo's server.py
│   └── public/        index.html, app.js, styles.css
├── gpt-live/          GPT-Live (gpt-live-1) full-duplex voice on Azure OpenAI   → port 3000
│   ├── server.py      WebRTC SDP relay (POST /api/session) + WebSocket relay (WS /live)
│   ├── public/        app.js (session client, timeline, delegation tools), i18n.js (en/zh)
│   └── .env           BASE_URL, API_KEY, GPT_LIVE_MODEL, DELEGATION_MODEL, ...
├── decision/          Decision models side by side                              → port 3001
│   ├── server.py      maps one question spec to each provider's wire format, normalizes answers
│   ├── public/        app.js (editor, results grid), scenarios.js (preset scenarios)
│   └── .env           MS_DECISION_*, GPT_DECISION_*, JEV_* (BASE_URL, API_KEY, MODEL, AUTH_HEADER)
├── images/            Image models side by side                                 → port 3002
│   ├── server.py      POST /api/generate (OpenAI and MAI image APIs), POST /api/judge (Responses API), image store
│   ├── public/        app.js (prompt editor, scoreboard, image cards, lightbox), scenarios.js (prompts + checklists)
│   └── .env           GPT_IMAGE_* and MAI_* (BASE_URL, API_KEY, AUTH_HEADER), deployment names, optional per-model and JUDGE_* overrides
└── webiq/             Web grounding APIs side by side                           → port 3003
    ├── server.py      one Service class per search API; POST /api/search, /api/relevance, /api/speedtest
    ├── public/        app.js (leaderboard, speed chart, lane cards), scenarios.js (preset questions)
    ├── test_relevance.py  pytest regressions for relevance dedup, judge adapters, and grade validation (mocked, no keys)
    └── .env           WEBIQ_*, TAVILY_*, EXA_*, BRAVE_*, PERPLEXITY_*, PARALLEL_*, SERPAPI_* keys; MODEL_* + JUDGE_MODEL, MS_DECISION_* / GPT_DECISION_* / JEV_* for relevance judges
```

### Demos

| Demo | What it shows | Services |
|---|---|---|
| `gpt-live/` | Talking over a voice model that listens while it speaks; delegation of reasoning and tool calls to a backend model, on a live three-lane timeline | Azure OpenAI / Foundry `gpt-live-1` + a Responses backend model |
| `decision/` | The same input and typed questions (yes/no, choice, score) sent to three decision models; answers, probabilities, agreement, latency, and raw wire format side by side | Microsoft-Decision-1 (Foundry), OpenAI / Azure OpenAI Decisions API (`gpt-6-luna`), TypeSafe Jev |
| `images/` | One prompt to four image models at the same pixel size; time to image, a per-image checklist for instruction following (ticked by hand or by a blind judge model), quality score, and cost side by side | Foundry: `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` (Azure OpenAI image API), `MAI-Image-2.6`, `MAI-Image-2.6-Flash` (MAI image API); optional vision judge via Responses |
| `webiq/` | One query to Web IQ and six competing search APIs (Google results via SerpApi among them), compared on the search results alone: search latency and a speed test, blind-judged relevance (an LLM or a decision model as judge), freshness, content returned, and cost | Microsoft Web IQ, Google via SerpApi, Tavily, Exa, Brave Search, Perplexity Search, Parallel; judges: Azure OpenAI Responses, Microsoft-Decision-1, GPT Decisions API, Jev |

Each demo's README has run steps, a "What to show" script, settings, and troubleshooting.

## Running

```bash
./start.sh [--all] [--open]   # Python check, then the hub on http://localhost:8000; --all starts every demo, --open opens the browser
uv run hub/server.py          # the hub directly
cd decision && uv run server.py   # or run any demo on its own
```

Python 3.10+. With [uv](https://docs.astral.sh/uv/), `uv run` creates `.venv` from `pyproject.toml` on first use; `uv sync` does it ahead of time. Without uv: `python3 -m pip install -e .` once, then `python3 hub/server.py`. The hub sta## Conventions

Keep new demos consistent with the existing ones:

- **FastAPI, no build step.** `server.py` is a FastAPI app built with `demokit.create_app()`; the page is static HTML + ES modules in `public/`, served by `demokit.serve()`. All servers share the dependencies in the root `pyproject.toml`; add one only when nothing there or in the standard library will do.
- **Shared code lives in `src/demokit/`.** Use `load_env`, `read_json`, `reply`, `Upstream`, `auth_headers`, `parse_url`/`safe_host`/`origin`, `upstream_message`/`with_hint`, `key_missing`, `num`, `dig`. A helper used by one demo stays in that demo's `server.py`.
- **Secrets stay on the server.** Keys come from the demo's `.env` (read by `demokit.load_env`, no python-dotenv; real environment variables win). The browser only talks to `localhost`; the server proxies to the service and never returns keys. Commit `.env.example`, never `.env`.
- **Same server skeleton.** Module docstring listing the routes → config (with the endpoint resolver it needs) → domain logic → http routes → helpers → `if __name__ == "__main__": serve(...)` with the banner. `serve` prints a clear message and exits when the port is busy.
- **Keep the wire format the page expects.** Response JSON keys are camelCase (`latencyMs`, `notConfigured`) even though Python names are snake_case; every failure is `{"error": message}` (with `ok: false` on the demo routes).
- **`GET /api/config` is required.** Return at least `{ "ready": boolean, "problems": string[] }` plus whatever the page needs to show (model, host). The hub uses it to tell *running*, *needs setup*, and *stopped* apart.
- **Accept whatever the portal shows.** Normalize base URLs (Azure resource endpoint, project URL, or full path) into the exact endpoint, and auto-pick `api-key` vs `Bearer` auth for Azure hosts with an `*_AUTH_HEADER` override (`auth_headers` does this).
- **Explain failures in the UI.** Turn upstream 401/403/404/422 into a message that names the `.env` variable to check (`with_hint`).
- **Measure on a warm pool.** Call services through one `Upstream` per server; its `Reply.timing` splits connect from response time, which the latency rows show.
- **Shared look.** Schibsted Grotesk + JetBrains Mono, the same color tokens with a dark-mode block, 18px-radius surfaces on a grey background, and layouts that work at phone width with no horizontal scroll. Copy tokens from an existing `styles.css`.
- **Comment density.** A docstring per file describing its routes or role, and a one-line comment or docstring where the *why* isn't obvious. No narrating comments.

## Adding a demo

1. Create `<name>/` with `server.py`, `public/`, `.env.example`, `.gitignore` (copy from `decision/`), and `README.md`.
2. Pick an unused port (next is `3004`) and set it as `PORT` in `.env.example`.
3. Implement `GET /api/config` as above.
4. Add an entry to `demos.json`. The hub reads the port from the demo's `.env` (falling back to `defaultPort`), so the two stay in sync.
5. Add a row to the **Demos** table above and to the demo tables in `README.md` and `README.zh-CN.md`.

## Checking changes

Only `webiq/` has automated tests (`uv run pytest` from the repo root); they load a fresh copy of the server with a fixed environment, mock every upstream call, and need no `.env`. Add or update a test there when changing relevance grading, dedup, or scoring. Before calling any change done:

- `python -m py_compile <file>` on every changed Python file (the code must also run on Python 3.10: no backslashes or reused quotes inside f-string braces).
- Run the tests above.
- Start the demo and `curl localhost:<port>/api/config`.
- When a real key isn't available, point the provider's `*_BASE_URL` at a small local mock server and run the flow through the page, then check the browser console for errors.
- Load the page at desktop width and at 375px wide.
