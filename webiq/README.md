# Web IQ demo

A browser demo that sends **one query to Microsoft Web IQ and the leading web search APIs for AI** in parallel and compares the search results themselves: speed, relevance (graded blind by a judge model), freshness, how much content comes back, and cost.

| Service | What it is | Endpoint the server calls |
|---|---|---|
| **Microsoft Web IQ** | Microsoft's web grounding API (passages tuned for LLMs) | `POST https://api.microsoft.ai/v3/search/web` (or `/search/news`), `x-apikey` |
| **Tavily** | Search API built for agents | `POST https://api.tavily.com/search`, Bearer |
| **Exa** | Neural search with highlights | `POST https://api.exa.ai/search`, `x-api-key` |
| **Brave Search** | Independent index, extra snippets | `GET https://api.search.brave.com/res/v1/web/search` (or `/news/search`), `X-Subscription-Token` |
| **Perplexity Search** | Ranked results with page snippets | `POST https://api.perplexity.ai/search`, Bearer |
| **Parallel Basic**, **Parallel Advanced** | Search with LLM-ready excerpts, one lane per `PARALLEL_MODE` | `POST https://api.parallel.ai/v1/search`, `x-api-key` |
| **Google via SerpApi** | Google's results page, scraped and parsed by SerpApi (Google has no self-serve web search API) | `GET https://serpapi.com/search.json?engine=google` (`tbm=nws` for news), `api_key` in the query string |

## Run it

1. Fill in `.env` (copy from `.env.example`). Each search service needs only its key; any left empty shows as *not configured* with a sign-up link, and the others still run.
   ```
   WEBIQ_API_KEY=...
   TAVILY_API_KEY=...          # optional, likewise EXA_, BRAVE_, PERPLEXITY_, PARALLEL_, SERPAPI_
   MODEL_BASE_URL=https://<resource>.services.ai.azure.com   # for the relevance judge
   MODEL_API_KEY=...
   JUDGE_MODEL=gpt-6.1-sol
   # optional: decision models as judges, same settings as decision/.env
   MS_DECISION_BASE_URL=...   MS_DECISION_API_KEY=...   MS_DECISION_MODEL=...
   GPT_DECISION_BASE_URL=...  GPT_DECISION_API_KEY=...
   JEV_API_KEY=...
   ```
2. `uv run server.py` (Python 3.10+; `uv run` installs the dependencies the first time), then open **http://localhost:3003**. Or start it from the DemoBox hub.

## What to show

- **Speed.** The *Search* column is the search API alone, measured on this server. Press **Speed test** for one warm-up and 10 sequential calls per service on open connections: p50, p95, and the spread, sorted fastest first. The network round trip to each host is shown, so service time can be told apart from distance (Microsoft quotes 164 ms p95 for Web IQ; this measures it from where you are).
- **Relevance judge.** Pick it under the services: the LLM judge (`JUDGE_MODEL`), a decision model (**Microsoft-Decision-1**, the **GPT Decisions API**, or **Jev**), or *Off*. Every judge gets the same pooled input: the grading rules, the question, and every result from every service, shuffled and without service names. The LLM judge returns all grades as JSON in one call; a decision model answers one 0–3 score question per result (in batches of 20, sent in parallel) and the grade is its most probable level. Decision models take their task from the question and the level descriptions and treat the input as data, so the key rule (judge what a result says, not how old it is) is stated in every question and level too; with it only in the input, they marked older pages down. The line under the table says which judge graded and how long it took; decision models typically grade 30–40 results in 1–4 s, against 6–7 s for the LLM judge, and agree with it closely. Switch judges and run again to show that the ranking holds.
- **Relevance.** Once every search is back, the judge grades every result from every service, shuffled, without the service names. Each result gets 0–3: **3** gives the answer with specifics, **2** partly answers, **1** on topic but doesn't answer or has been superseded, **0** off topic. Broad questions (*latest developments*) need concrete, checkable specifics for a 3; a list of buzzwords is 2 at most. A question that lists what it wants (*launch date, US price, and chip* for three phones) needs most of that list for a 3; a result with one or two of the facts is 2. For *latest* questions, the judge uses the other services' results and the dates to spot results that have been replaced (a narrow *latest version* question) without marking a page down for its age alone. The judge sees each result's whole text as the service returned it (within the content budget) and the current time, in UTC and New York. A question about *today* or *this week* counts only documents about that period, in the question's own time zone (US markets: New York), and the judge tells the day from what a document reports rather than its date label, which is often stale on live pages. Results share a grade across services only when their normalized URL, full case-sensitive excerpt, title, and date match. Within a service, a repeated URL or identical full excerpt is marked *dup* and scores 0; a shared excerpt prefix is not a duplicate. The score weights grades 3, 2, 1, 0 as 3, 1, 0, 0: a result that states the answer counts fully, a partial answer a third, and an on-topic result that doesn't help answer counts nothing, because it only fills the model's context. A service with ten such results would otherwise outscore one with three answers and seven misses. The weighted sum is averaged over the number of results asked for (missing search results count as 0) and scaled to 0–10; the table also shows how many results state the answer, and *n/k returned* when a service sent fewer results than asked for, so a low score from a short list reads differently from one from poor results. Every document must have exactly one valid grade. Missing, refused, duplicate, unknown, or invalid judgments fail the relevance run instead of becoming numeric scores. Click a result to see the exact text the service returned.
- **Freshness intent.** Web IQ has no freshness parameter; it decides per query whether to rank fresh documents first and reports it as `querySignals.freshness`. The Web IQ card shows it as *freshness query: yes / no* (web search only), which explains old results for a question that says *latest*.
- **Freshness.** *Freshest* is the newest date among the results the judge graded useful (2 or 3), so a new page that doesn't help answer doesn't count. The cell shows how many of those useful results carry a date; services date their results differently (Web IQ `lastUpdatedAt`, Brave `page_age`, Exa `publishedDate`, Perplexity `date`, SerpApi Google's display date, Tavily only on news searches, Parallel rarely), so it is ranked only when at least half the useful results are dated. Each value is tagged *ranked* or *not ranked* (greyed, with the reason on hover); only ranked values compete for best. *No dates* means the service sent none, not that its results are old. When a service sends no publish or update date, the date in the URL is used and marked *from URL*: an arXiv ID (`2610.01936` is October 2026, shown as the month and ranked as its 1st) or a date in the path (`/2026/08/08/`). A date the service sends always wins. Crawl dates are shown, marked *crawled*, but not ranked; when a service's newest crawl is newer than its newest publish date (Web IQ sends only a crawl date for some pages), the cell says so. Dates more than a day in the future are bad metadata and are ignored, with a note. With the judge off, all results count.
- **Content.** Characters of page content each service returned, counted exactly. Passages and highlights (Web IQ, Exa, Parallel) are long; Google's snippets via SerpApi are a line or two. More isn't better by itself: read it next to *Relevance*. Set `WEBIQ_CONTENT_FORMAT=markdown` (needs full document access) to compare whole pages with passages.
- **Presets.** The question menu has 17 presets in six groups, each a kind of question a model can't answer from training data alone:
  - **News:** this week in AI; why the Nasdaq Composite moved in its last completed session. That question asks about the last *completed* session so it has an answer at any hour, including daytime in Asia.
  - **Facts that change:** latest Node.js release, latest F1 result, current US federal funds rate.
  - **Several things at once:** three flagship phones, NVIDIA's latest quarter, minimum wage in three places.
  - **Policy and guidance:** EU AI Act obligations for general-purpose AI, US citizens' visa-free entry to China, CDC flu vaccine advice, the UK energy price cap.
  - **Research:** a keyword-style research query.
  - **Other languages:** two Chinese questions, one Japanese, one German. Each preset sets the market, so non-English coverage is compared with the right language and country fields.

  Add your own in `public/scenarios.js`.
- **Cost.** Pay-as-you-go list price per 1,000 searches for the mode in use, each covering up to 10 results with their content. Exa returns the actual charge and Tavily its credits; both are used when present. Volume plans are cheaper (Tavily down to about $5, SerpApi from $25 on Starter to under $4 at a million searches a month), and Web IQ pricing can depend on your Microsoft agreement, so set `*_PRICE_PER_1K` to your contract for a customer-specific comparison.
- **On the wire.** Every search request and response, with long text shortened.

## How the comparison is kept fair

- Same query, same result count, and the same **content budget per result**. It is sent where the API has a setting (Web IQ `maxLength`, Exa `highlights.maxCharacters`, Parallel `max_chars_per_result`, Perplexity `max_tokens_per_page` as characters ÷ 4), and the server cuts any result that comes back longer, so *Content* and *Relevance* compare the same amount of text. Exa treats its setting as a target and often returns more; the result shows *trimmed from N*. Tavily, Brave, and SerpApi return fixed-size snippets; SerpApi's are Google's one- or two-line snippets.
- Market maps to each API's own language and country fields.
- **News** uses each API's news search and limits it to the past week wherever the API has a time window: Tavily `topic=news` + `time_range=week`, Exa `category=news` + `startPublishedDate`, Brave `/news/search` + `freshness=pw`, Perplexity `search_recency_filter=week`, SerpApi `tbm=nws` + `tbs=qdr:w`. Web IQ's `/search/news` and Parallel have no time window, so they can return older pages. Without the window, Tavily's news search returned articles up to a year old.
- SerpApi caches a query for an hour and serves repeats from cache for free. `SERPAPI_NO_CACHE=true` (the default) makes every call, including the speed test, a live Google search.
- All services run in parallel from the same server over pooled keep-alive connections.
- Modes are configurable, so you can match tiers: `TAVILY_SEARCH_DEPTH`, `EXA_SEARCH_TYPE`, `PARALLEL_MODE`, `WEBIQ_CONTENT_FORMAT`. The card header shows the mode in use.

## Settings (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `WEBIQ_API_KEY` | — | Web IQ is in limited access: https://www.microsoft.com/en-us/webiq |
| `WEBIQ_BASE_URL` | `https://api.microsoft.ai/v3` | |
| `WEBIQ_CONTENT_FORMAT` | `passage` | `passage`, `markdown`, `text`, `html` |
| `WEBIQ_SAFE_SEARCH` | (not sent; Web IQ uses `strict`) | `strict` blocks adult, racy, violent, hate, and self-harm content; `off` blocks only illegal content, closer to the other services' defaults. Web search only; the news endpoint has no such parameter. |
| `TAVILY_API_KEY`, `TAVILY_SEARCH_DEPTH` | —, `basic` | `basic` / `fast` / `ultra-fast` / `advanced` (2 credits) |
| `EXA_API_KEY`, `EXA_SEARCH_TYPE` | —, `auto` | `auto` / `lite` / `deep-lite` / `deep` |
| `BRAVE_API_KEY` | — | Web or News search with `extra_snippets` |
| `PERPLEXITY_API_KEY` | — | |
| `PARALLEL_API_KEY`, `PARALLEL_MODE` | —, `basic,advanced` | `turbo` / `fast` ($1) / `basic` / `advanced` ($5). A comma-separated list gives one lane per mode; the default compares Parallel's $5 tier with Web IQ's $7. |
| `SERPAPI_API_KEY`, `SERPAPI_NO_CACHE` | —, `true` | Google results via SerpApi. The key travels in the URL; the wire view and logs redact it. |
| `*_BASE_URL` | each vendor's API | Override for a proxy or gateway. |
| `*_PRICE_PER_1K` | list prices, Oct 2026 | Web IQ 7, Tavily 8 (basic; advanced uses 2 credits), Exa 7, Brave 5, Perplexity 5, Parallel 5 (basic, advanced) or 1 (turbo, fast), SerpApi 15 (Developer plan, $75 for 5,000) |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_AUTH_HEADER` | —, —, `auto` | Azure OpenAI / Foundry resource for the relevance judge (Responses API). |
| `JUDGE_MODEL`, `JUDGE_REASONING_EFFORT` | —, — | Deployment for the LLM judge. |
| `MS_DECISION_BASE_URL`, `_API_KEY`, `_MODEL`, `_AUTH_HEADER` | —, —, `Microsoft-Decision-1`, `auto` | Microsoft-Decision-1 on Foundry as a judge (`/providers/microsoft/v1/systemone`). Same settings as `decision/.env`. |
| `GPT_DECISION_BASE_URL`, `_API_KEY`, `_MODEL`, `_AUTH_HEADER` | —, —, `gpt-6-luna`, `auto` | GPT Decisions API (OpenAI or Azure OpenAI, `/decisions`) as a judge. |
| `JEV_BASE_URL`, `_API_KEY`, `_MODEL`, `_AUTH_HEADER` | `https://api.typesafe.ai`, —, `jev-latest`, `auto` | TypeSafe Jev as a judge. |
| `RELEVANCE_JUDGE` | `llm` | Judge selected when the page opens: `llm`, `microsoft`, `openai`, or `jev`. With the judge *Off*, Relevance and the useful-results filter on Freshest are skipped. |
| `PORT` | `3003` | |
| `REQUEST_TIMEOUT_SECONDS` | `90` | |
| `DEBUG` | `false` | Prints request and response bodies in the server console. |

## Troubleshooting

- **401 / 403**: the message names the key to check (`WEBIQ_API_KEY`, `MODEL_API_KEY`, …).
- **402** (Exa) or out-of-credit errors: top up the account.
- **429**: rate limit; wait a moment, or run the speed test with fewer services ticked.
- **"Relevance grading failed"**: the message names the variable to check (`MODEL_*` / `JUDGE_MODEL` for the LLM judge, `MS_DECISION_*`, `GPT_DECISION_*`, or `JEV_*` for a decision model). The search columns still work; pick another judge or *Off*.

## Tests

Run the relevance regression tests from the repo root:

```bash
uv run pytest
```

The tests use isolated configuration and mocked judge responses without reading `.env` or calling external APIs. They cover full-excerpt deduplication, provider-order independence, metadata differences, all judge adapters, invalid or incomplete grades, and parallel batches.

## Files

```
server.py            config, one adapter per search API, POST /api/search, /api/relevance, /api/speedtest
test_relevance.py    pytest regressions for relevance dedup, judge adapters, and grade validation
public/index.html    page
public/app.js        query editor, parallel runs, leaderboard, speed chart, result cards, wire view
public/scenarios.js  preset questions (edit or add your own here)
public/i18n.js       English and Chinese UI strings
public/styles.css
```

References: [Microsoft Web IQ](https://www.microsoft.com/en-us/webiq) · [Web IQ Web Search reference](https://learn.microsoft.com/en-us/web-iq/reference/web-search) · [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) · [Exa Search API](https://exa.ai/docs/reference/search) · [Brave Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) · [Perplexity Search API](https://docs.perplexity.ai/api-reference/search-post) · [Parallel Search API](https://docs.parallel.ai/api-reference/search-beta/search) · [SerpApi Google Search API](https://serpapi.com/search-api)
