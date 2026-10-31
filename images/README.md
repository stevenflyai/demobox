# Image models demo

A browser demo that sends the **same prompt at the same pixel size** to four image models on Microsoft Foundry, in parallel, and lines up the images with their speed, instruction following, quality, and cost:

| Model | Vendor | Endpoint the server calls | Wire format |
|---|---|---|---|
| **GPT-Image-2.5 Flare** | Azure OpenAI | `<resource>/openai/v1/images/generations` | `size: "WxH"`, `quality` |
| **GPT-Image-2.5 Sunburst** | Azure OpenAI | `<resource>/openai/v1/images/generations` | `size: "WxH"`, `quality` |
| **MAI-Image-2.6** | Microsoft AI | `<resource>.services.ai.azure.com/mai/v1/images/generations` | `width`, `height`, `web_grounding` |
| **MAI-Image-2.6-Flash** | Microsoft AI | `<resource>.services.ai.azure.com/mai/v1/images/generations` | `width`, `height`, `web_grounding` |

Flare is OpenAI's fast default and Sunburst its precision tier. MAI-Image-2.6 is Microsoft AI's flagship and Flash its faster, cheaper variant. All four return a base64 PNG.

## Run it

1. Deploy the models in Foundry (Foundry portal → Models → Deploy; MAI models are Global Standard, in preview). The GPT-Image and MAI models each get their own URL and key in `.env`, so they can live in different resources:
   ```
   GPT_IMAGE_BASE_URL=https://<resource>.openai.azure.com        # Flare and Sunburst
   GPT_IMAGE_API_KEY=...

   MAI_BASE_URL=https://<resource>.services.ai.azure.com          # MAI-Image-2.6 and 2.6-Flash
   MAI_API_KEY=...
   ```
   If both families are in the same resource, put the same values in both. If your deployment names differ from the model names, set `GPT_IMAGE_FLARE_MODEL`, `GPT_IMAGE_SUNBURST_MODEL`, `MAI_IMAGE_MODEL`, `MAI_IMAGE_FLASH_MODEL`. A model left unconfigured shows as *not configured*, and the others still run.
2. Optional: set `JUDGE_MODEL` to a vision-capable deployment in the GPT-Image resource (default `gpt-5.5`) to grade images automatically.
3. Start the server (Python 3.10+; `uv run` installs the dependencies the first time):
   ```
   uv run server.py
   ```
4. Open **http://localhost:3002**, pick a scenario, and press **Generate on all models**.

Or start it from the hub at the repo root (`./start.sh` there, then **Start** on the card).

## What to show

- **Speed.** Each card counts up live while its model works; the scoreboard's *Time to image* row then shows each model's time from request to full image, measured on this server, with the fastest marked. Set *Runs* to 2 or 3 for a median and range (each run is billed). The bar under each time is on one scale across models, so lengths compare directly.
- **Instruction following.** Every scenario comes with a checklist of concrete, visible requirements: exact sign text, counts, left/right placement, a clock reading 3:15, five fingers, Chinese characters. Tick each item per image (click cycles pass → fail → not scored), or let the judge fill it in. *Follows the prompt* sums the passes per model. Edit the checklist freely; one line per requirement.
- **Quality.** Click any image to open it full size, then use ← / → to flip between models at the same pixel size; this is the best way to compare detail on a projector. With the judge on, each image also gets a 1–10 quality score with a one-line reason. *Your rating* (1–5 stars) records the room's opinion next to it.
- **The judge is blind.** It receives the prompt, the checklist, and the image, but not which model made it. It is strict on purpose (partly met = fail; text must match exactly). It is still a model: a hand tick always overrides it, and the card shows what the judge said when you disagree. If the judge is a GPT model, mention that when comparing it with the MAI models.
- **Cost.** GPT-Image reports token usage, so the card shows cost per image at list price. If MAI doesn't return usage, the row shows its list price per 1M output tokens instead. Defaults are list prices as of October 2026; override them with `*_PRICE_INPUT_PER_1M` / `*_PRICE_OUTPUT_PER_1M`.
- **Same pixels for everyone.** Each aspect ratio maps to one size every model accepts (multiples of 16 for GPT-Image; each edge ≥ 768 and at most 2,359,296 pixels for MAI-Image-2.6). *Large* sits right at the MAI limit, e.g. 2048 × 1152 for 16:9. The note under the settings shows the exact size.
- **Model-specific knobs.** *Quality* (low … max) only goes to GPT-Image; higher levels are slower and cost more output tokens. *Web grounding* only goes to MAI: it can look up real people, places, and products on Bing before drawing them.
- **On the wire.** Expand a model to see the exact request and response (base64 image data replaced by its size). Sunburst and Flare may return `revised_prompt`; the card shows it under *Prompt as revised by the model*.
- **中文 / English.** Switch the interface language in the top-right menu, or from the DemoBox hub. The *Chinese poster* scenario tests Hanzi rendering.

## Settings (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `GPT_IMAGE_BASE_URL` | — | Resource for Flare and Sunburst. `*.openai.azure.com`, `*.services.ai.azure.com`, `*.cognitiveservices.azure.com`, or a project URL all work; the server calls `/openai/v1/images/generations`. A full URL ending in `/images/generations` is used as-is. |
| `GPT_IMAGE_API_KEY` | — | Stays in the server process. |
| `MAI_BASE_URL` | — | Resource for MAI-Image-2.6 and 2.6-Flash. Calls always go to `*.services.ai.azure.com/mai/v1/images/generations`; another address of the same resource is switched automatically. |
| `MAI_API_KEY` | — | Stays in the server process. |
| `GPT_IMAGE_AUTH_HEADER`, `MAI_AUTH_HEADER` | `auto` | `api-key` header for `*.azure.com`, `Bearer` otherwise. Override with `api-key` or `bearer` (e.g. an Entra ID token). |
| `GPT_IMAGE_FLARE_MODEL` … `MAI_IMAGE_FLASH_MODEL` | the model names | The **deployment name** in Foundry. |
| `<PREFIX>_BASE_URL`, `_API_KEY`, `_AUTH_HEADER` | the `GPT_IMAGE_*` or `MAI_*` value | Per-model override for a model in yet another resource. Prefixes: `GPT_IMAGE_FLARE`, `GPT_IMAGE_SUNBURST`, `MAI_IMAGE`, `MAI_IMAGE_FLASH`, and `JUDGE` (falls back to `GPT_IMAGE_*`). |
| `JUDGE_MODEL` | empty (`gpt-5.5` in `.env.example`) | Vision model for the judge, called with the Responses API. Empty turns the judge off. |
| `JUDGE_REASONING_EFFORT` | — | `minimal` / `low` / `medium` / `high`, or empty for non-reasoning models. |
| `PORT` | `3002` | |
| `REQUEST_TIMEOUT_SECONDS` | `180` | Per request. `max` quality at large sizes can take over a minute. |
| `DEBUG` | `false` | Prints request and response bodies (without image data) in the server console. |

## Troubleshooting

- **401 / 403**: wrong key, or the wrong header for your gateway. The message names the variable in use (`GPT_IMAGE_API_KEY`, `MAI_API_KEY`, or a per-model override). Try `*_AUTH_HEADER=bearer`.
- **404**: the deployment name or endpoint is wrong. The error shows the exact URL that was called; compare it with the deployment page.
- **429**: MAI image deployments start at a few requests per minute (6 RPM at tier 1). Use *Runs* = 1, or raise the quota.
- **Blocked by the content filter**: the provider's safety system rejected the prompt or the image. Rephrase.
- **"This image is no longer on the server"** when judging: images live in memory (last 48), so a server restart drops them. Generate again.

## Files

```
server.py            config, request mapping, POST /api/generate, POST /api/judge, GET /api/images/:id, GET /api/config
public/index.html    page
public/app.js        prompt editor, parallel runs, scoreboard, image cards, checklist, lightbox, wire view
public/scenarios.js  preset prompts and checklists (edit or add your own here)
public/i18n.js       English and Chinese UI strings
public/styles.css
```

References: [MAI image models in Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image) · [Azure OpenAI image generation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/dall-e) · [MAI-Image-2.6 model card](https://microsoft.ai/pdf/MAI-Image-2.6-Model-Card.pdf)
