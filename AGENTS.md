# AGENTS.md

Guidance for coding agents (and humans) working in this repo.

## What this is

**DemoBox** is a collection of small, self-contained browser demos of AI services, used for live customer and internal demos. Each demo is its own folder with its own Node server, `.env`, and README. A hub at the root lists the demos and can start, stop, and open them from one page.

The goal of every demo is to be **quick to set up and clear on stage**: fill in a key, run `npm start`, open a localhost page that shows the service's distinctive behavior.

## Layout

```
demobox/
├── AGENTS.md          this file
├── README.md          project overview and quick start (English); README.zh-CN.md is the Chinese version
├── .gitignore         .env and variants (keeps .env.example), node_modules, logs, OS/editor and tool state; each demo has a copy
├── start.sh           Node version check, then the hub (--all, --open)
├── package.json       npm start → hub (port 8000); npm run start:all → hub + every demo
├── demos.json         registry the hub reads: id, name, tagline, description, dir, defaultPort, tags
├── hub/               unified launcher UI
│   ├── server.js      GET /api/demos, POST /api/demos/:id/start|stop (localhost only)
│   └── public/        index.html, app.js, styles.css
├── gpt-live/          GPT-Live (gpt-live-1) full-duplex voice on Azure OpenAI   → port 3000
│   ├── server.js      WebRTC SDP relay (POST /api/session) + WebSocket relay (WS /live)
│   ├── public/        app.js (session client, timeline, delegation tools), i18n.js (en/zh)
│   └── .env           BASE_URL, API_KEY, GPT_LIVE_MODEL, DELEGATION_MODEL, ...
├── decision/          Decision models side by side                              → port 3001
│   ├── server.js      maps one question spec to each provider's wire format, normalizes answers
│   ├── public/        app.js (editor, results grid), scenarios.js (preset scenarios)
│   └── .env           MS_DECISION_*, GPT_DECISION_*, JEV_* (BASE_URL, API_KEY, MODEL, AUTH_HEADER)
├── images/            Image models side by side                                 → port 3002
│   ├── server.js      POST /api/generate (OpenAI and MAI image APIs), POST /api/judge (Responses API), image store
│   ├── public/        app.js (prompt editor, scoreboard, image cards, lightbox), scenarios.js (prompts + checklists)
│   └── .env           GPT_IMAGE_* and MAI_* (BASE_URL, API_KEY, AUTH_HEADER), deployment names, optional per-model and JUDGE_* overrides
└── webiq/             Web grounding APIs side by side                           → port 3003
    ├── server.js      one adapter per search API; POST /api/search, /api/relevance, /api/speedtest
    ├── public/        app.js (leaderboard, speed chart, lane cards), scenarios.js (preset questions)
    ├── relevance.test.js  node:test regressions for relevance dedup, judge adapters, and scoring (mocked, no keys)
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
./start.sh [--all] [--open]  # same as below, after a Node version check; --open opens the hub in the browser
npm start                  # hub on http://localhost:8000; start demos from the page
npm run start:all          # hub + every demo at once
cd decision && npm start   # or run any demo on its own
```

Node 18.17+. `gpt-live` needs `npm install` (one dependency, `ws`); the hub runs it automatically the first time. `decision`, `images`, `webiq`, and `hub` have no dependencies.

## Conventions

Keep new demos consistent with the existing ones:

- **Plain Node, no build step.** `server.js` uses `node:http` and built-ins; the page is static HTML + ES modules in `public/`. Add an npm dependency only when there is no reasonable built-in (e.g. `ws` for a WebSocket server).
- **Secrets stay on the server.** Keys come from the demo's `.env` (parsed by the small `loadEnvFile` helper, no dotenv). The browser only talks to `localhost`; the server proxies to the service and never returns keys. Commit `.env.example`, never `.env`.
- **Same server skeleton.** Sections in order: config → domain logic → http → start → helpers. Reuse `sendJson`, `readJson`, `serveStatic`, `loadEnvFile`, `safeHost`. On `EADDRINUSE`, print a clear message and exit.
- **`GET /api/config` is required.** Return at least `{ "ready": boolean, "problems": string[] }` plus whatever the page needs to show (model, host). The hub uses it to tell *running*, *needs setup*, and *stopped* apart.
- **Accept whatever the portal shows.** Normalize base URLs (Azure resource endpoint, project URL, or full path) into the exact endpoint, and auto-pick `api-key` vs `Bearer` auth for Azure hosts with an `*_AUTH_HEADER` override.
- **Explain failures in the UI.** Turn upstream 401/403/404/422 into a message that names the `.env` variable to check.
- **Shared look.** Schibsted Grotesk + JetBrains Mono, the same color tokens with a dark-mode block, 18px-radius surfaces on a grey background, and layouts that work at phone width with no horizontal scroll. Copy tokens from an existing `styles.css`.
- **Comment density.** A short header comment per file describing its routes or role, and a one-line comment where the *why* isn't obvious. No narrating comments.

## Adding a demo

1. Create `<name>/` with `package.json` (`"type": "module"`, `"start": "node server.js"`), `server.js`, `public/`, `.env.example`, `.gitignore` (copy from `decision/`), and `README.md`.
2. Pick an unused port (next is `3004`) and set it as `PORT` in `.env.example`.
3. Implement `GET /api/config` as above.
4. Add an entry to `demos.json`. The hub reads the port from the demo's `.env` (falling back to `defaultPort`), so the two stay in sync.
5. Add a row to the **Demos** table above and to the demo tables in `README.md` and `README.zh-CN.md`.

## Checking changes

Only `webiq/` has automated tests (`cd webiq && node --test relevance.test.js`); they mock every upstream call and need no `.env`. Add or update a test there when changing relevance grading, dedup, or scoring. Before calling any change done:

- `node --check <file>` on every changed server file.
- In `webiq/`, run the tests above.
- Start the demo and `curl localhost:<port>/api/config`.
- When a real key isn't available, point the provider's `*_BASE_URL` at a small local mock server and run the flow through the page, then check the browser console for errors.
- Load the page at desktop width and at 375px wide.
