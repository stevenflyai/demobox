# Decision models demo

A browser demo that sends the **same input and the same typed questions** to three decision models and lines up their answers side by side:

| Provider | Model | Endpoint the server calls | Wire format |
|---|---|---|---|
| **Microsoft-Decision-1** | your Foundry deployment | `<foundry-endpoint>/providers/microsoft/v1/systemone` | `systemone` |
| **GPT Decisions API** | `gpt-6-luna` | `<base>/decisions` (OpenAI or Azure OpenAI) | `decisions` |
| **Jev** (TypeSafe) | `jev-latest` | `https://api.typesafe.ai/v1/systemone` | `systemone` |

Decision models don't write prose. They return a probability (yes/no), one option from a fixed set (choice), or a position on an ordered scale (score), each with per-option probabilities.

## Run it

1. Open `.env` and fill in the providers you have. Any provider left empty shows as *not configured*, and the others still run.
   ```
   MS_DECISION_BASE_URL=https://<resource>.services.ai.azure.com
   MS_DECISION_API_KEY=...
   MS_DECISION_MODEL=<your deployment name>

   GPT_DECISION_BASE_URL=https://api.openai.com/v1      # or https://<resource>.openai.azure.com
   GPT_DECISION_API_KEY=...

   JEV_API_KEY=...
   ```
2. Start the server (Python 3.10+; `uv run` installs the dependencies the first time):
   ```
   uv run server.py
   ```
3. Open **http://localhost:3001**, pick a scenario, and press **Run on all providers**.

Or start it from the hub at the repo root (`./start.sh` there, then **Start** on the card).

## What to show

- **Same question, three answers.** Each row is one question. The badge on the left says whether the providers agree (same choice, same side of 50%, or scores within 0.5).
- **Latency.** Set *Runs* to 3 or 5 to get a median and range per provider. Latency is measured on this server, from sending the request to reading the full response, so it includes your network path to each endpoint. Each provider's bar splits it into *connect* (DNS, TCP and TLS on a new connection, hatched) and *response* (one network round trip plus model time), with the measured round trip below. A far-away region shows up as a long connect and a large round trip.
- **List price.** The row under the latencies shows each provider's list price (USD per 1M tokens) and what a million runs of this exact request would cost, using the token counts each provider reported. Jev and Microsoft-Decision-1 have the same price per token but count the same input differently, so their cost per run differs. Defaults are the published list prices as of October 2026; override them with `*_PRICE_INPUT_PER_1M` / `*_PRICE_OUTPUT_PER_1M` in `.env` (see `.env.example`).
- **中文 / English.** Switch the interface language in the top-right menu, or from the DemoBox hub. Preset titles are translated; their content is left as written, since it is the model input.
- **Keep connections warm** (on by default) pings each endpoint every 20 seconds with a keyless GET while the page is visible. The provider rejects it without running a model, so nothing is billed, and runs reuse an open connection instead of paying for a new handshake each time. Untick it to show cold-start latency.
- **Probabilities, not just labels.** The bars show the full distribution. A low top probability is the signal to escalate to a person or a bigger model.
- **On the wire.** Expand a provider to see the exact request and response. Microsoft-Decision-1 and Jev share the `systemone` shape (`state` + `questions` keyed by name); OpenAI uses `input` + a `questions` array with `predicate` / `choices` / `levels`.
- **Structured state.** Paste a JSON object as the state (see *Grade an AI answer*). `systemone` providers get it as an object; the Decisions API gets the JSON text.

## How questions map

| In the UI | Microsoft-Decision-1 / Jev | GPT Decisions API |
|---|---|---|
| Yes / no | `{ "type": "noul", "instructions" }` | `{ "type": "predicate", "name", "instructions" }` |
| Choice | `{ "type": "choice", "criteria": { value: description } }` | `{ "type": "choice", "choices": [{ value, description }] }` |
| Score | `{ "type": "score", "criteria": ["level", …] }` (lowest first; descriptions folded in as `"label: description"`) | `{ "type": "score", "levels": [{ label, description }] }` |

Answers are normalized on the server (`normalize_answers` in `server.py`) so the page renders one shape for everyone.

## Settings (`.env`)

Each provider has the same four variables, with prefix `MS_DECISION_`, `GPT_DECISION_`, or `JEV_`:

| Variable | Default | Notes |
|---|---|---|
| `*_BASE_URL` | Jev: `https://api.typesafe.ai` | Paste the endpoint from the portal. The server adds the right path. A full URL ending in `/systemone` or `/decisions` is used as-is. |
| `*_API_KEY` | — | Required. Stays in the server process. |
| `*_MODEL` | `Microsoft-Decision-1` / `gpt-6-luna` / `jev-latest` | On Azure, this is the **deployment name**. |
| `*_AUTH_HEADER` | `auto` | `api-key` header for `*.azure.com`, `Bearer` otherwise. Override with `api-key` or `bearer`. |
| `PORT` | `3001` | |
| `REQUEST_TIMEOUT_SECONDS` | `30` | Per provider request. |
| `DEBUG` | `false` | Prints every request and response body in the server console. |

## Troubleshooting

- **401 / 403**: wrong key, or the wrong header for your gateway. Try `*_AUTH_HEADER=bearer` (or `api-key`). Foundry also accepts an Entra ID token as `Bearer`.
- **404**: the base URL is wrong. The error shows the exact URL that was called; compare it with the endpoint on the deployment page.
- **422 / "valid deployment"**: `*_MODEL` must be the deployment name in that resource (Azure) or a model name the provider lists (`GET /v1/models` on TypeSafe).
- **GPT Decisions API on Azure**: only regions where `gpt-6-luna` is available (not East US 2 at launch).

## Files

```
server.py            config, provider mapping, POST /api/decide, POST /api/warm, GET /api/config
public/index.html    page
public/app.js        scenario editor, parallel runs, results grid, wire view
public/scenarios.js  preset scenarios (edit or add your own here)
public/styles.css
```

References: [Microsoft-Decision-1 in Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision) · [Azure OpenAI Decisions API](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/decisions) · [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions) · [TypeSafe System One API](https://docs.typesafe.ai/api)
