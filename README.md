# DemoBox

**English** · [简体中文](README.zh-CN.md)

Small, self-contained browser demos of AI services, built for live customer and internal demos. Each demo shows one service's distinctive behavior on a single localhost page, and a hub starts, stops, and opens them all from one place.

Fill in a key, run `npm start`, open the page.

## Demos

| Demo | What it shows | Port |
|---|---|---|
| [GPT-Live](gpt-live/) | Full-duplex voice on Azure OpenAI: talk over the model while it speaks, and watch it delegate reasoning and tool calls to a backend model on a live three-lane timeline | 3000 |
| [Decision models](decision/) | The same input and typed questions (yes/no, choice, score) sent to Microsoft-Decision-1, the GPT Decisions API, and Jev; answers, probabilities, agreement, and latency side by side | 3001 |
| [Image models](images/) | One prompt to GPT-Image-2.5 Flare and Sunburst, MAI-Image-2.6 and Flash; time to image, an instruction-following checklist (by hand or a blind judge model), quality, and cost | 3002 |
| [Web IQ](webiq/) | One query to Microsoft Web IQ and six other search APIs (Google via SerpApi, Tavily, Exa, Brave, Perplexity, Parallel); latency, blind-judged relevance, freshness, content returned, and cost | 3003 |

Each demo's README has its setup, a "What to show" script, settings, and troubleshooting.

## Quick start

Requires **Node.js 18.17+**. Most demos have no npm dependencies; `gpt-live` needs one (`ws`), which the hub installs the first time you start it.

```bash
git clone <this repo> demobox && cd demobox

# Give each demo you want to run its own .env, then fill in the keys
cp webiq/.env.example webiq/.env

./start.sh --open          # hub on http://localhost:8000, opened in the browser
```

Other ways to start:

```bash
npm start                  # hub only; start demos from the page
npm run start:all          # hub + every demo at once
./start.sh --all --open    # same, after a Node version check, and open the hub
cd webiq && npm start      # any demo on its own
```

The hub shows each demo as **Running**, **Running · needs setup** (started, but keys are missing), or **Stopped**. A demo with only some providers configured still runs; the rest show as *not configured*. The pages work in English and Chinese.

## Configuration

Every demo reads its own `.env` (see its `.env.example` for every setting). Endpoints can be pasted as the portal shows them: an Azure resource endpoint, a Foundry project URL, or a full path. Azure hosts get `api-key` or `Bearer` auth picked automatically, with an `*_AUTH_HEADER` override.

Keys stay on the server. The browser only talks to `localhost`; each demo's server calls the service and never returns keys to the page. `.env` files are git-ignored. Commit `.env.example`, never `.env`.

## Layout

```
demobox/
├── start.sh        launcher with a Node version check (--all, --open)
├── demos.json      registry the hub reads
├── hub/            launcher UI on port 8000
├── gpt-live/       each demo: server.js, public/, .env.example, README.md
├── decision/
├── images/
└── webiq/
```

## Tests

The Web IQ demo has relevance-scoring regression tests. They use mocked responses, so they need no keys or network:

```bash
cd webiq && node --test relevance.test.js
```

## Contributing

[AGENTS.md](AGENTS.md) has the conventions (plain Node with no build step, the server skeleton, the required `/api/config` route, the shared look), the steps for adding a demo, and the checks to run before calling a change done.
