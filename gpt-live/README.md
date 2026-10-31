# GPT-Live demo

A browser demo for **GPT-Live (`gpt-live-1`)**, OpenAI's full-duplex voice model, running on Azure OpenAI / Microsoft Foundry.
GPT-Live listens and speaks at the same time and hands reasoning and tool calls to a backend model (Responses delegation).
The page makes both visible on a live three-lane timeline: **You**, **GPT-Live**, and **Backend**.

## Run it

1. Open `.env` and fill in the two required values:
   ```
   BASE_URL=https://<your-resource>.openai.azure.com
   API_KEY=<key from Azure portal → Keys and Endpoint>
   ```
2. Start the server (Node 18.17+):
   ```
   npm install
   npm start
   ```
3. Open **http://localhost:3000** in Chrome or Edge, allow the microphone, and press **Start conversation**.

The key stays in the Node process. The browser only talks to `localhost`.

### Azure prerequisites

- A deployment of **`gpt-live-1`** in the resource. If you named it something else, set `GPT_LIVE_MODEL`.
- A backend model deployment in the **same resource** for delegation. The default is `DELEGATION_MODEL=gpt-5.5`; change it to your deployment name.
  Leave it empty to run GPT-Live alone, without tools.
- The server normalizes `BASE_URL` to `https://<resource>.openai.azure.com/openai/v1`, so you can paste the endpoint from the portal as-is.

## What to show

- **Talk over it.** Interrupt mid-sentence, or think out loud with long pauses. Both lanes light up at once, and GPT-Live doesn't jump into your pauses.
- **Delegation and tools.** Ask "What's the weather in Shanghai right now?" or "上海现在几点？". A green block appears in the Backend lane while the backend model calls `get_weather` / `get_current_time`. The calls run in the browser (live data from Open-Meteo) and their results flow back to the voice.
- **Context mid-call.** Under *Add context mid-call*, send something like "The caller is a Gold member" as *Know it quietly*, then ask about upgrades.
  - *Say it aloud* uses `session.commentary.append`.
  - *Follow it as an instruction* uses `session.instructions.append`.
- **Event log.** Open it to show the raw protocol (audio chunks are counted, not printed).

## Connections

| | WebRTC (default) | WebSocket relay |
|---|---|---|
| Path | Browser ⇄ Azure media directly. The server only relays the SDP offer to `POST {BASE_URL}/live/sessions` | Browser ⇄ this server ⇄ `wss://…/openai/v1/live/sessions` |
| Audio | Opus over media tracks, browser echo cancellation | PCM16 24 kHz, base64 `session.input_audio.append` / `session.output_audio.delta` |
| Events | `oai-events` data channel | Same socket |
| Use when | Normal demos, laptop speakers | WebRTC is blocked on the network, or you want to show the raw audio protocol |

With the WebSocket relay, use headphones so GPT-Live doesn't hear itself.

## Settings (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | — | Required. Azure resource endpoint, or `https://api.openai.com/v1` for OpenAI. |
| `API_KEY` | — | Required. |
| `GPT_LIVE_MODEL` | `gpt-live-1` | Deployment name. |
| `GPT_LIVE_VOICE` | `marin` | Default voice. You can also pick one in the UI. |
| `DELEGATION_MODEL` | `gpt-5.5` | Backend deployment. Leave empty to disable delegation. |
| `DELEGATION_REASONING_EFFORT` | `low` | Leave empty for models without reasoning. |
| `ENABLE_WEB_SEARCH` | `false` | Adds the hosted `web_search` tool to the backend, if your resource supports it. |
| `AUTH_HEADER` | `auto` | `api-key` for `*.azure.com`, `Bearer` otherwise. Override with `api-key` or `bearer`. |
| `PORT` | `3000` | |
| `DEBUG` | `false` | Prints every non-audio event in the server console. |

## Troubleshooting

- **401 / 403**: wrong key, or the wrong header for your gateway. Try `AUTH_HEADER=bearer` (or `api-key`).
- **404**: `BASE_URL` is wrong, or `gpt-live-1` isn't deployed in that resource or region.
- **Error mentioning a model or deployment at start**: `DELEGATION_MODEL` must match a deployment in the same resource.
- **Voice rejected**: pick `marin`. The other names in the list are the launch voices and may not all be enabled on your resource yet.
- **Mic blocked**: browsers only allow the microphone on `localhost` or `https`. To demo from another machine, put the server behind HTTPS.
- **WebRTC fails on corporate Wi-Fi**: switch *Connection* to *WebSocket relay*.

## Files

```
server.js            config, POST /api/session (WebRTC), WS /live (relay)
public/index.html    page
public/app.js        session client, timeline, transcripts, delegation + tools
public/pcm-capture.js  AudioWorklet: mic → PCM16 24 kHz
public/styles.css
```

Protocol references: [Use GPT-Live (Microsoft Foundry)](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-live) · [GPT-Live event reference](https://learn.microsoft.com/en-us/azure/foundry/openai/gpt-live-reference) · [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)
