"""Web IQ demo server.

- GET  /api/config    : which search services and the relevance judge are configured (never returns keys)
- POST /api/search    : runs one search service on { provider, query, topic, count, chars, market } and returns
                        normalized results, measured latency, content size, cost, and the raw request/response
- POST /api/relevance : grades every service's results 0-3 from one pooled, shuffled input, without service names,
                        with the LLM judge or a decision model; repeats within a service score 0 as duplicates
- POST /api/speedtest : one warm-up plus N sequential searches on one service; returns every latency
Keys are read from .env and never leave this process.
"""

import asyncio
import json
import os
import random
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode
from zoneinfo import ZoneInfo

from fastapi import Request

from demokit import (
    Upstream, UpstreamError, auth_headers, create_app, dig, is_azure_host, key_missing, load_env, num, origin,
    parse_url, read_json, reply, safe_host, serve, upstream_message, with_hint,
)

ROOT = Path(__file__).resolve().parent
env = load_env(__file__)

# ───────────────────────── config ─────────────────────────


@dataclass
class Provider:
    id: str
    service: str  # which adapter in SERVICES builds and parses its calls
    label: str
    vendor: str
    env_prefix: str
    base_url: str
    api_key: str
    price_per_1k: float
    signup: str
    mode: str | None = None

    def problems(self) -> list[str]:
        problems = []
        if key_missing(self.api_key):
            problems.append(f"{self.env_prefix}_API_KEY is empty")
        if not parse_url(self.base_url):
            problems.append(f"{self.env_prefix}_BASE_URL is not a valid URL")
        return problems


def provider(id, label, vendor, prefix, base_url, price, signup, service=None, mode=None) -> Provider:
    return Provider(
        id=id, service=service or id, label=label, vendor=vendor, env_prefix=prefix,
        base_url=env(f"{prefix}_BASE_URL", base_url).rstrip("/"),
        api_key=env(f"{prefix}_API_KEY"),
        price_per_1k=env.number(f"{prefix}_PRICE_PER_1K", price),
        signup=signup, mode=mode,
    )


# Parallel prices by mode: turbo and fast $1, basic and advanced $5. PARALLEL_MODE can list several modes, one lane
# each; the default runs the two $5 modes, the tier that compares with Web IQ's.
PARALLEL_MODES = list(dict.fromkeys(m.strip() for m in env("PARALLEL_MODE", "basic,advanced").lower().split(",") if m.strip()))


def parallel(mode: str) -> Provider:
    several = len(PARALLEL_MODES) > 1
    return provider(
        f"parallel-{mode}" if several else "parallel", f"Parallel {mode.capitalize()}" if several else "Parallel",
        "Parallel Web Systems", "PARALLEL", "https://api.parallel.ai", 5 if mode in ("basic", "advanced") else 1,
        "https://platform.parallel.ai", service="parallel", mode=mode,
    )


# Every service is asked for the same number of results with the same per-result content budget where it
# supports one, so latency, content size, and relevance compare like for like. Prices are list prices in USD
# per 1,000 searches as of October 2026; set *_PRICE_PER_1K to match your contract.
PROVIDERS = [
    provider("webiq", "Microsoft Web IQ", "Microsoft", "WEBIQ", "https://api.microsoft.ai/v3", 7, "https://www.microsoft.com/en-us/webiq"),
    provider("tavily", "Tavily", "Tavily", "TAVILY", "https://api.tavily.com", 8, "https://app.tavily.com"),
    provider("exa", "Exa", "Exa", "EXA", "https://api.exa.ai", 7, "https://dashboard.exa.ai"),
    provider("brave", "Brave Search", "Brave", "BRAVE", "https://api.search.brave.com", 5, "https://api-dashboard.search.brave.com"),
    provider("perplexity", "Perplexity Search", "Perplexity", "PERPLEXITY", "https://api.perplexity.ai", 5, "https://www.perplexity.ai/account/api"),
    *(parallel(mode) for mode in PARALLEL_MODES),
    provider("serpapi", "Google via SerpApi", "SerpApi", "SERPAPI", "https://serpapi.com", 15, "https://serpapi.com/manage-api-key"),
]

WEBIQ_FORMAT = env("WEBIQ_CONTENT_FORMAT", "passage")
# Sent only when set; Web IQ's own default is strict. The news endpoint has no safeSearch parameter.
WEBIQ_SAFE_SEARCH = env("WEBIQ_SAFE_SEARCH").lower() if re.fullmatch(r"off|strict", env("WEBIQ_SAFE_SEARCH"), re.I) else ""
TAVILY_DEPTH = env("TAVILY_SEARCH_DEPTH", "basic")
EXA_TYPE = env("EXA_SEARCH_TYPE", "auto")
SERPAPI_NO_CACHE = not re.fullmatch(r"0|false|no|off", env("SERPAPI_NO_CACHE", "true"), re.I)


def resolve_responses_endpoint(raw: str) -> str:
    """Accept whatever the portal shows (resource endpoint, project URL, or a full path) and return the Responses URL."""
    u = parse_url(raw)
    if not u:
        return ""
    path = u.path.rstrip("/")
    if not re.search(r"/responses$", path, re.I):
        if is_azure_host(u.hostname):
            path = "/openai/v1/responses"  # also drops /images/generations or /api/projects/...
        else:
            path = f"{path}/responses" if re.search(r"/v1$", path, re.I) else f"{path}/v1/responses"
    return origin(u) + path


def resolve_decision_endpoint(protocol: str, raw: str) -> str:
    """Same rules as the decision demo: accept the portal's resource endpoint, project URL, or full path."""
    u = parse_url(raw)
    if not u:
        return ""
    path = u.path.rstrip("/")
    azure = is_azure_host(u.hostname)
    if protocol == "decisions":
        if not re.search(r"/decisions$", path, re.I):
            if azure:
                path = "/openai/v1/decisions"
            elif u.hostname == "api.openai.com":
                path = "/v1/decisions"
            else:
                path = f"{path}/decisions"
    elif not re.search(r"/systemone$", path, re.I):
        if azure:
            path = "/providers/microsoft/v1/systemone"
        else:
            path = f"{path}/systemone" if re.search(r"/v1$", path, re.I) else f"{path}/v1/systemone"
    return origin(u) + path


# The relevance judge uses the Responses API on an Azure OpenAI / Foundry resource.
MODEL_RAW_BASE_URL = env("MODEL_BASE_URL")
MODEL_ENDPOINT = resolve_responses_endpoint(MODEL_RAW_BASE_URL)
MODEL_API_KEY = env("MODEL_API_KEY")
MODEL_AUTH = auth_headers(env("MODEL_AUTH_HEADER", "auto").lower(), MODEL_API_KEY, MODEL_ENDPOINT)
JUDGE_MODEL = env("JUDGE_MODEL")
JUDGE_EFFORT = env("JUDGE_REASONING_EFFORT")


@dataclass
class DecisionJudge:
    """Decision models can grade relevance instead of the LLM judge, with the same settings as decision/.env.
    They answer typed questions with probabilities: here, one 0-3 score question per result.
      systemone : { model, state, questions: { name: { type: score, instructions, criteria: [level, …] } } }
                  Microsoft-Decision-1 (Foundry) and TypeSafe Jev
      decisions : { model, input, questions: [ { type: score, name, instructions, levels: [{ label, description }] } ] }
                  OpenAI / Azure OpenAI Decisions API
    """

    id: str
    label: str
    protocol: str
    env_prefix: str
    raw_base_url: str
    endpoint: str
    api_key: str
    model: str
    auth_header: str

    def problems(self) -> list[str]:
        problems = []
        if not self.raw_base_url:
            problems.append(f"{self.env_prefix}_BASE_URL is empty")
        elif not self.endpoint:
            problems.append(f"{self.env_prefix}_BASE_URL is not a valid URL ({self.raw_base_url})")
        if key_missing(self.api_key):
            problems.append(f"{self.env_prefix}_API_KEY is empty")
        return problems

    def headers(self) -> dict:
        return {**auth_headers(self.auth_header, self.api_key, self.endpoint), "Content-Type": "application/json", "Accept": "application/json"}


def decision_judge(id, label, protocol, prefix, model, base_url="") -> DecisionJudge:
    raw = env(f"{prefix}_BASE_URL", base_url)
    return DecisionJudge(
        id=id, label=label, protocol=protocol, env_prefix=prefix, raw_base_url=raw,
        endpoint=resolve_decision_endpoint(protocol, raw), api_key=env(f"{prefix}_API_KEY"),
        model=env(f"{prefix}_MODEL", model), auth_header=env(f"{prefix}_AUTH_HEADER", "auto").lower(),
    )


DECISION_JUDGES = [
    decision_judge("microsoft", "Microsoft-Decision-1", "systemone", "MS_DECISION", "Microsoft-Decision-1"),
    decision_judge("openai", "GPT Decisions API", "decisions", "GPT_DECISION", "gpt-6-luna"),
    decision_judge("jev", "Jev", "systemone", "JEV", "jev-latest", "https://api.typesafe.ai"),
]
DEFAULT_JUDGE = env("RELEVANCE_JUDGE", "llm").lower()  # llm, or a decision judge id; the page can switch per run
DECISION_BATCH = 20  # score questions per decision request; batches run in parallel

PORT = int(env.number("PORT", 3003)) or 3003
TIMEOUT = env.number("REQUEST_TIMEOUT_SECONDS", 90) or 90
DEBUG = env.flag("DEBUG")
HUB_URL = os.environ.get("DEMOBOX_HUB_URL") or "http://localhost:8000"

TOPICS = ("web", "news")
COUNTS = (3, 5, 10)
CHARS = (500, 1000, 2000, 4000)
MAX_CHARS = max(CHARS)  # the judge sees all of every result, up to the largest budget
# News mode searches the past week wherever the API has a time window (Tavily, Exa, Brave, Perplexity, SerpApi); Web IQ and Parallel have none.
NEWS_WINDOW = timedelta(days=7)
# Market → language and country, plus the spellings each service wants.
MARKETS = {
    "en-US": {"language": "en", "country": "US", "tavily": "united states", "brave": "en", "google": "en"},
    "en-GB": {"language": "en", "country": "GB", "tavily": "united kingdom", "brave": "en", "google": "en"},
    "zh-CN": {"language": "zh", "country": "CN", "tavily": "china", "brave": "zh-hans", "google": "zh-cn"},
    "ja-JP": {"language": "ja", "country": "JP", "tavily": "japan", "brave": "jp", "google": "ja"},
    "de-DE": {"language": "de", "country": "DE", "tavily": "germany", "brave": "de", "google": "de"},
}
MAX_QUERY_CHARS = 1000
MAX_SPEED_RUNS = 20


def model_problems() -> list[str]:
    problems = []
    if not MODEL_RAW_BASE_URL:
        problems.append("MODEL_BASE_URL is empty")
    elif not MODEL_ENDPOINT:
        problems.append(f"MODEL_BASE_URL is not a valid URL ({MODEL_RAW_BASE_URL})")
    if key_missing(MODEL_API_KEY):
        problems.append("MODEL_API_KEY is empty")
    if not JUDGE_MODEL:
        problems.append("JUDGE_MODEL is empty")
    return problems


def judge_list() -> list[dict]:
    llm_problems = model_problems()
    return [
        {"id": "llm", "kind": "llm", "label": JUDGE_MODEL or "LLM judge", "model": JUDGE_MODEL or None,
         "host": safe_host(MODEL_ENDPOINT) or None, "ready": not llm_problems, "problems": llm_problems},
        *({"id": d.id, "kind": "decision", "label": d.label, "model": d.model, "host": safe_host(d.endpoint) or None,
           "ready": not d.problems(), "problems": d.problems()} for d in DECISION_JUDGES),
    ]


# ───────────────────────── search services ─────────────────────────


@dataclass
class Query:
    query: str
    topic: str  # web | news
    count: int
    chars: int
    market: str

    @property
    def m(self) -> dict:
        return MARKETS[self.market]

    @property
    def news(self) -> bool:
        return self.topic == "news"


@dataclass
class Call:
    url: str
    method: str
    headers: dict
    body: dict | None = None


class Service:
    """One search API: build(p, q) → Call, parse(data, q) → [{ title, url, content, date, dateKind }],
    cost(data, p) → USD for this call when the service reports it."""

    def build(self, p: Provider, q: Query) -> Call: ...

    def parse(self, d, q: Query) -> list[dict]: ...

    def cost(self, d, p: Provider) -> float | None:
        return None

    def fresh_intent(self, d) -> bool | None:
        return None


class WebIQ(Service):
    # https://api.microsoft.ai/v3/search/web and /search/news; content arrives as query-relevant passages.
    def build(self, p, q):
        body = {
            "query": q.query, "maxResults": q.count, "contentFormat": WEBIQ_FORMAT, "maxLength": q.chars,
            "language": q.m["language"], "region": q.m["country"],
        }
        if WEBIQ_SAFE_SEARCH and not q.news:
            body["safeSearch"] = WEBIQ_SAFE_SEARCH
        base = re.sub(r"/search(/\w+)?$", "", p.base_url, flags=re.I)
        return Call(f"{base}/search/{'news' if q.news else 'web'}", "POST", {"x-apikey": p.api_key, "Content-Type": "application/json"}, body)

    def fresh_intent(self, d):
        # Whether Web IQ decided the query needs fresh documents (web search only); there is no request parameter for it.
        v = dig(d, "querySignals", "freshness")
        return v if isinstance(v, bool) else None

    def parse(self, d, q):
        dates = [("datePublished", "published"), ("publishedAt", "published"), ("lastUpdatedAt", "updated"), ("lastUpdated", "updated"), ("crawledAt", "crawled")]
        return [
            {"title": first(r, "title", "name"), "url": r.get("url"), "content": first(r, "content", "snippet", "description"), **pick_date(r, dates)}
            for r in records(d, "webResults", "newsResults", "results", "value")
        ]


class Tavily(Service):
    def build(self, p, q):
        body = {"query": q.query, "max_results": q.count, "search_depth": TAVILY_DEPTH, "topic": "news" if q.news else "general"}
        if q.news:
            body["time_range"] = "week"
        body["include_usage"] = True
        if not q.news:
            body["country"] = q.m["tavily"]
        return Call(f"{p.base_url}/search", "POST", {"Authorization": f"Bearer {p.api_key}", "Content-Type": "application/json"}, body)

    def parse(self, d, q):
        return [{"title": r.get("title"), "url": r.get("url"), "content": r.get("content"), **pick_date(r, [("published_date", "published")])}
                for r in records(d, "results")]

    def cost(self, d, p):
        # 1 credit for basic/fast, 2 for advanced; the list price is per 1,000 basic searches.
        credits = num(dig(d, "usage", "credits"))
        return credits * p.price_per_1k / 1000 if credits is not None else None


class Exa(Service):
    def build(self, p, q):
        body = {"query": q.query, "type": EXA_TYPE, "numResults": q.count, "userLocation": q.m["country"]}
        if q.news:
            body |= {"category": "news", "startPublishedDate": iso(datetime.now(timezone.utc) - NEWS_WINDOW)}
        body["contents"] = {"highlights": {"maxCharacters": q.chars}}
        return Call(f"{p.base_url}/search", "POST", {"x-api-key": p.api_key, "Content-Type": "application/json"}, body)

    def parse(self, d, q):
        def content(r):
            highlights = r.get("highlights")
            if isinstance(highlights, list) and highlights:
                return " … ".join(map(str, highlights))
            return first(r, "text", "summary")

        return [{"title": r.get("title"), "url": r.get("url"), "content": content(r), **pick_date(r, [("publishedDate", "published")])}
                for r in records(d, "results")]

    def cost(self, d, p):
        return num(dig(d, "costDollars", "total"))  # Exa reports the actual charge


class Brave(Service):
    # Web search with extra_snippets returns the description plus up to five more excerpts per result.
    def build(self, p, q):
        params = {"q": q.query, "count": str(q.count), "country": q.m["country"], "search_lang": q.m["brave"], "extra_snippets": "true"}
        if q.news:
            params["freshness"] = "pw"
        return Call(f"{p.base_url}/res/v1/{'news' if q.news else 'web'}/search?{urlencode(params)}", "GET",
                    {"X-Subscription-Token": p.api_key, "Accept": "application/json"})

    def parse(self, d, q):
        results = dig(d, "web", "results")
        rows = [r for r in results if isinstance(r, dict)] if isinstance(results, list) else records(d, "results")

        def content(r):
            extra = r.get("extra_snippets") if isinstance(r.get("extra_snippets"), list) else []
            return strip_tags(" … ".join(str(s) for s in [r.get("description"), *extra] if s))

        # page_age is when Brave saw the page change, not necessarily when it was first published.
        return [{"title": strip_tags(r.get("title")), "url": r.get("url"), "content": content(r), **pick_date(r, [("page_age", "updated")])}
                for r in rows]


class Perplexity(Service):
    def build(self, p, q):
        body = {
            "query": q.query, "max_results": q.count, "max_tokens_per_page": max(64, round(q.chars / 4)),
            "country": q.m["country"], "search_language_filter": [q.m["language"]],
        }
        if q.news:
            body["search_recency_filter"] = "week"
        return Call(f"{p.base_url}/search", "POST", {"Authorization": f"Bearer {p.api_key}", "Content-Type": "application/json"}, body)

    def parse(self, d, q):
        dates = [("date", "published"), ("last_updated", "updated")]
        return [{"title": r.get("title"), "url": r.get("url"), "content": r.get("snippet"), **pick_date(r, dates)} for r in records(d, "results")]


class Parallel(Service):
    def build(self, p, q):
        body = {
            "objective": q.query,
            "search_queries": [q.query[:200]],
            "mode": p.mode,
            "advanced_settings": {
                "max_results": q.count,
                "excerpt_settings": {"max_chars_per_result": q.chars},
                "location": q.m["country"].lower(),
            },
        }
        base = re.sub(r"/v1(beta)?$", "", p.base_url, flags=re.I)
        return Call(f"{base}/v1/search", "POST", {"x-api-key": p.api_key, "Content-Type": "application/json"}, body)

    def parse(self, d, q):
        def content(r):
            excerpts = r.get("excerpts")
            return " … ".join(map(str, excerpts)) if isinstance(excerpts, list) else first(r, "excerpt", "content")

        return [{"title": r.get("title"), "url": r.get("url"), "content": content(r), **pick_date(r, [("publish_date", "published")])}
                for r in records(d, "results")]


class SerpApi(Service):
    # Google's results page, scraped and parsed by SerpApi. Snippets only (no page text), so the content budget
    # doesn't apply. The key can only go in the query string. no_cache stops a repeated query (speed test) from
    # returning SerpApi's one-hour cache instead of a live Google search.
    def build(self, p, q):
        params = {"engine": "google", "q": q.query, "num": str(q.count), "hl": q.m["google"], "gl": q.m["country"].lower()}
        if q.news:
            params |= {"tbm": "nws", "tbs": "qdr:w"}
        if SERPAPI_NO_CACHE:
            params["no_cache"] = "true"
        params["api_key"] = p.api_key
        base = re.sub(r"/search(\.json)?$", "", p.base_url, flags=re.I)
        return Call(f"{base}/search.json?{urlencode(params)}", "GET", {})

    def parse(self, d, q):
        return [
            {"title": r.get("title"), "url": r.get("link"), "content": r.get("snippet"),
             **pick_date({"date": display_date(r.get("date"))}, [("date", "published")])}
            for r in records(d, "news_results" if q.news else "organic_results")
        ]


SERVICES: dict[str, Service] = {
    "webiq": WebIQ(), "tavily": Tavily(), "exa": Exa(), "brave": Brave(),
    "perplexity": Perplexity(), "parallel": Parallel(), "serpapi": SerpApi(),
}


def validate_search(body: dict | None) -> str | None:
    if not isinstance(body, dict):
        return "Request body must be JSON"
    query = body.get("query")
    if not isinstance(query, str) or not query.strip():
        return "The question is empty"
    if len(query) > MAX_QUERY_CHARS:
        return f"The question is longer than {MAX_QUERY_CHARS} characters"
    if body.get("topic") not in TOPICS:
        return f'Unknown topic "{body.get("topic")}"'
    if not is_int(body.get("count")) or body["count"] not in COUNTS:
        return f"Result count must be one of {', '.join(map(str, COUNTS))}"
    if not is_int(body.get("chars")) or body["chars"] not in CHARS:
        return f"Content per result must be one of {', '.join(map(str, CHARS))}"
    if not isinstance(body.get("market"), str) or body["market"] not in MARKETS:
        return f'Unknown market "{body.get("market")}"'
    body["query"] = query.strip()
    return None


def query_of(body: dict) -> Query:
    return Query(body["query"], body["topic"], int(body["count"]), int(body["chars"]), body["market"])


async def run_search(p: Provider, q: Query):
    call = SERVICES[p.service].build(p, q)
    if DEBUG:
        print(f"[{p.id}] → {call.method} {redact_url(call.url)}\n{json.dumps(call.body, ensure_ascii=False) if call.body else ''}")
    r = await send(call.url, call.method, {"Accept": "application/json", **call.headers}, call.body)
    if DEBUG:
        print(f"[{p.id}] ← {r.status} {r.timing['totalMs']}ms {r.text[:800]}")
    return call, r


def search_cost(p: Provider, data) -> float:
    cost = SERVICES[p.service].cost(data, p)
    return cost if cost is not None else p.price_per_1k / 1000


def find_provider(body: dict | None) -> Provider | None:
    return next((p for p in PROVIDERS if body and p.id == body.get("provider")), None)


def search_error(p: Provider, status: int, data, text: str) -> str:
    return upstream_error(f"{p.env_prefix}_API_KEY", f"{p.env_prefix}_BASE_URL", status, data, text)


def result_of(x: dict, q: Query) -> dict:
    """One normalized result, held to the content budget, with the best date it carries."""
    # Some APIs treat the content budget as a target (Exa's highlights run over it), so hold every service to it here.
    full = clean(x.get("content"))
    content = clip(full, q.chars)
    # With no publish or update date from the service, a date in the URL (arXiv ID, /2026/08/08/) says when the page was written.
    from_url = url_date(x["url"]) if not x.get("date") or x.get("dateKind") == "crawled" else None
    result = {
        "title": clean(x.get("title")) or x["url"],
        "url": x["url"],
        "domain": re.sub(r"^www\.", "", safe_host(x["url"])),
        "content": content,
    }
    if len(content) < len(full):
        result["trimmedFrom"] = len(full)
    result["date"] = from_url["date"] if from_url else x.get("date")
    result["dateKind"] = "url" if from_url else x.get("dateKind") if x.get("date") else None
    if from_url and from_url.get("month"):
        result["dateMonth"] = True
    if from_url and x.get("date"):
        result["crawledAt"] = x["date"]
    return result


# ───────────────────────── relevance judge ─────────────────────────

# Relevance is graded per result, on exactly what the search returned, across all services in one
# call: one consistent judge, and documents from other services show when a result is out of date.
RELEVANCE_INSTRUCTIONS = "\n".join([
    "You grade web search results for how well each one helps answer a question. You get the current date and time (UTC, with the weekday), the question, and numbered documents. Each document is the title, URL, date (if any), and the excerpt a search service returned. Grade only what the document shows, because that is all a model answering from it would see.",
    "Grades:",
    "3 = gives the answer, or most of it, with specifics: the fact, figure, name, date, version, or named development asked for. When the question spells out a list of things to give (named items to compare, or named attributes of each, such as a launch date, a price, and a chip), 3 needs most of them; a document with only one or a few of them is 2. A question that asks in general (latest updates, what is new) does not spell out a list; the broad-question rule applies to it instead. For a broad question (latest developments, what is new, trends), 3 needs concrete, checkable specifics such as named releases, features, methods, papers, products, or results; a generic list of trends or buzzwords is 2 at most.",
    "2 = partly answers: only some of the things a question lists, relevant specifics that help but are not the main thing asked, or the answer only implied or stated in general terms.",
    "1 = on topic but does not help answer: background, a general page, or information that has been superseded.",
    "0 = off topic, empty, or spam.",
    "Superseded means replaced, not merely older. When the question asks for the latest, current, or recent information, a document is superseded (1) only if what it presents as current has since been replaced, as the other documents or the dates show: it calls version 26 the latest when another document shows a newer version released, or it reports a figure or result that a newer document updates.",
    "Tell a narrow question from a broad one. A narrow question asks for the single latest item (the latest version, the most recent result, today's figure); only documents with that item answer it. A broad question asks about recent updates or developments in general; a document about anything still current answers it, even if other documents are newer. For example, coverage of the current major release still answers \"what are the latest updates\" after a point release, but not \"what is the latest version number\".",
    "Questions about today, yesterday, or this week mean that period where the question is set, in its own time zone (US markets: New York time, where a trading day runs 9:30 a.m. to 4 p.m.). Before that period has any activity at the time given (a market question asked before the open, or on a weekend or holiday), today means the most recent session: a document about that last completed session answers it, and so does one about moves so far today (pre-market futures); the asker may be in a time zone where that session already falls on today. Otherwise a document about an earlier day or week does not answer such a question (1), however close in time; one about the right period that gives figures or reasons does. Tell which day a document covers from what it reports (the weekday, date, and events it names), not from its date label alone: services' dates are often stale or wrong, and live pages keep an old URL or date while their text is new. Use the date and time given here, not your own sense of the date.",
    "Do not grade down a document for its age alone; recency is measured separately. Do not rely on your own knowledge of what is current; it may be out of date.",
    "Grade each document on its own; any number of them may earn the same grade. Grade every document exactly once, by its number.",
])

RELEVANCE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["grades"],
    "properties": {
        "grades": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False, "required": ["n", "grade"],
                "properties": {"n": {"type": "integer", "minimum": 1}, "grade": {"type": "integer", "minimum": 0, "maximum": 3}},
            },
        },
    },
}


@dataclass
class Doc:
    title: str
    url: str
    date: str
    text: str
    n: int = 0


def pool_documents(raw_lanes: list) -> tuple[list[Doc], list[dict]]:
    """Every lane's results as one list of distinct documents, plus each lane's items pointing into it.

    Grades are shared only when the URL, full excerpt, title, and date all match across services.
    Within a service, a repeated URL or excerpt is a duplicate and scores 0.
    """
    docs: list[Doc] = []
    by_key: dict[tuple, Doc] = {}
    lanes = []
    for lane in raw_lanes[:12]:
        lane = lane if isinstance(lane, dict) else {}
        sources = lane.get("sources")[:10] if isinstance(lane.get("sources"), list) else []
        seen_urls, seen_texts, items = set(), set(), []
        for s in sources:
            s = s if isinstance(s, dict) else {}
            url = normalize_url(s.get("url"))
            text = clean(s.get("content"))[:MAX_CHARS]
            title = clean(s.get("title"))
            date = date_label(s)
            if url in seen_urls or (text and text in seen_texts):
                items.append({"dup": True})
                continue
            seen_urls.add(url)
            if text:
                seen_texts.add(text)
            key = (url, title, date, text)
            if key not in by_key:
                by_key[key] = Doc(title, "" if s.get("url") is None else str(s["url"]), date, text)
                docs.append(by_key[key])
            items.append({"doc": by_key[key]})
        lanes.append({"id": "" if lane.get("id") is None else str(lane["id"]), "items": items})
    return docs, lanes


def date_label(s: dict) -> str:
    date = s.get("date")
    if not date:
        return ""
    if s.get("dateKind") == "url":
        return f"published (from the URL): {str(date)[:7] if s.get('dateMonth') else str(date)[:10]}"
    return f"{s.get('dateKind') or 'date'}: {date}"


def validate_grades(entries, docs: list[Doc]) -> dict:
    if not isinstance(entries, list):
        return {"ok": False, "error": "The judge did not return relevance grades"}
    expected = {d.n for d in docs}
    grades: dict[int, int] = {}
    for entry in entries:
        n = entry.get("n") if isinstance(entry, dict) else None
        if not is_int(n) or int(n) not in expected:
            return {"ok": False, "error": "The judge returned an unknown document number"}
        n = int(n)
        if n in grades:
            return {"ok": False, "error": f"The judge graded document [{n}] more than once"}
        grade = entry.get("grade")
        if not is_int(grade) or not 0 <= grade <= 3:
            return {"ok": False, "error": f"The judge returned an invalid or refused grade for document [{n}]; expected an integer from 0 to 3"}
        grades[n] = int(grade)
    if len(grades) != len(expected):
        missing = len(expected) - len(grades)
        return {"ok": False, "error": f"The judge left {missing} of {len(expected)} documents ungraded; relevance scores are unavailable"}
    return {"ok": True, "grades": grades}


async def grade_with_llm(text: str, docs: list[Doc]) -> dict:
    """The LLM judge grades every document in one call, as JSON."""
    request = {
        "model": JUDGE_MODEL,
        "instructions": RELEVANCE_INSTRUCTIONS,
        "input": text,
        "text": {"format": {"type": "json_schema", "name": "relevance_grades", "strict": True, "schema": RELEVANCE_SCHEMA}},
    }
    if JUDGE_EFFORT:
        request["reasoning"] = {"effort": JUDGE_EFFORT}
    try:
        r = await send(MODEL_ENDPOINT, "POST", {**MODEL_AUTH, "Content-Type": "application/json", "Accept": "application/json"}, request)
    except UpstreamError as exc:
        return {"ok": False, "error": f"Could not reach {safe_host(MODEL_ENDPOINT)}: {exc}"}
    data = r.data
    if not r.ok:
        return {"ok": False, "status": r.status,
                "error": upstream_error("MODEL_API_KEY", "MODEL_BASE_URL", r.status, data, r.text, JUDGE_MODEL, "JUDGE_MODEL")}
    try:
        out = json.loads(output_text(data))
    except ValueError:
        out = None
    validated = validate_grades(dig(out, "grades"), docs)
    if not validated["ok"]:
        return validated
    usage = {"input": num(dig(data, "usage", "input_tokens")), "output": num(dig(data, "usage", "output_tokens"))}
    return {**validated, "requests": 1, "usage": usage}


# A decision model gets the same rules and documents as its input, and one score question per document (levels 0-3).
# The grade is the most probable level. Batches of DECISION_BATCH questions run in parallel.
# Decision models take their task from the question and level text and treat the input as data, so the rules that
# matter most (judge content, not age) are stated here too; with them only in the input, older pages were marked down.
DECISION_LEVELS = [
    ("0", "Off topic, empty, or spam."),
    ("1", "On topic but does not help answer: background or a general page, or information that a newer document shows has been replaced (for example, it calls an older version the latest). Being older than other documents is not enough."),
    ("2", "Partly answers: relevant specifics that are not the main thing asked, or the answer stated only in general terms."),
    ("3", "Gives the answer with specifics. For a general question (latest updates, what is new), concrete specifics about a current development are enough. When the question itself lists the things to give, such as a launch date, a price, and a chip for each product, it covers most of that list. An older document qualifies when what it says is still current."),
]


def decision_instructions(n: int) -> str:
    return (
        f"Grade document [{n}] for how well its text helps answer the question. Judge what it says, not when it was written: a date or age never lowers the grade by itself, and recency is measured separately. "
        "Grade down for age only when the question asks for a single latest item (the latest version, the most recent result, today's figure) and another document shows a newer one. "
        "For a broad question (latest developments, what is new), a document about something still current answers it even if other documents are newer. "
        "A question about today, yesterday, or this week is answered only by documents about that period, placed with the time given at the top of the input; a document about an earlier day is 1. Before a market opens, or when it is closed for the day, today means the most recent completed session (or moves so far today, such as futures). Tell the day from what the text reports (weekday, date, events), not from its date label, which is often stale. The full grading rules are at the top of the input."
    )


async def grade_with_decision(d: DecisionJudge, text: str, docs: list[Doc]) -> dict:
    state = f"{RELEVANCE_INSTRUCTIONS}\n\n{text}"
    batches = [docs[i:i + DECISION_BATCH] for i in range(0, len(docs), DECISION_BATCH)]
    results = await asyncio.gather(*(decide(d, state, batch) for batch in batches))
    failed = next((x for x in results if not x["ok"]), None)
    if failed:
        return failed
    grades = {n: g for x in results for n, g in x["grades"].items()}
    usage = {
        "input": sum(dig(x, "usage", "input") or 0 for x in results),
        "output": sum(dig(x, "usage", "output") or 0 for x in results),
    }
    return {"ok": True, "requests": len(batches), "grades": grades, "usage": usage}


async def decide(d: DecisionJudge, state: str, batch: list[Doc]) -> dict:
    if d.protocol == "decisions":
        levels = [{"label": label, "description": description} for label, description in DECISION_LEVELS]
        request = {
            "model": d.model,
            "input": state,
            "questions": [{"type": "score", "name": f"doc{doc.n}", "instructions": decision_instructions(doc.n), "levels": levels} for doc in batch],
        }
    else:
        criteria = [f"{label}: {description}" for label, description in DECISION_LEVELS]
        request = {
            "model": d.model,
            "state": state,
            "questions": {f"doc{doc.n}": {"type": "score", "instructions": decision_instructions(doc.n), "criteria": criteria} for doc in batch},
        }
    if DEBUG:
        print(f"[relevance:{d.id}] → POST {d.endpoint} ({len(batch)} questions)")
    try:
        r = await send(d.endpoint, "POST", d.headers(), request)
    except UpstreamError as exc:
        return {"ok": False, "error": f"Could not reach {safe_host(d.endpoint)}: {exc}"}
    data = r.data
    if DEBUG:
        print(f"[relevance:{d.id}] ← {r.status} {r.timing['totalMs']}ms {r.text[:800]}")
    if not r.ok:
        return {"ok": False, "status": r.status, "error": upstream_error(
            f"{d.env_prefix}_API_KEY", f"{d.env_prefix}_BASE_URL", r.status, data, r.text, d.model, f"{d.env_prefix}_MODEL")}

    answers = dig(data, "answers")
    if d.protocol == "decisions":
        names = [dig(a, "name") for a in answers] if isinstance(answers, list) else None
    else:
        names = list(answers) if isinstance(answers, dict) else None
    if names is None:
        return {"ok": False, "error": "The judge did not return relevance answers"}
    expected = {f"doc{doc.n}": doc.n for doc in batch}
    entries = [{"n": expected.get(name) if isinstance(name, str) else None, "grade": decision_grade(d.protocol, answers, name)} for name in names]
    validated = validate_grades(entries, batch)
    if not validated["ok"]:
        return validated
    usage = dig(data, "usage")
    first_of = lambda *keys: next((usage[k] for k in keys if dig(usage, k) is not None), None)  # noqa: E731
    return {**validated, "usage": {"input": num(first_of("input_tokens", "prompt_tokens")), "output": num(first_of("output_tokens", "completion_tokens"))}}


def decision_grade(protocol: str, answers, name) -> int | None:
    """Most probable level of one score answer; falls back to the reported score. Refusals and missing answers: None."""
    if protocol == "decisions":
        a = next((x for x in answers if dig(x, "name") == name), None)
    else:
        a = answers.get(name) if isinstance(name, str) else None
    if not isinstance(a, dict) or a.get("type") == "refusal":
        return None
    probs = a.get("probabilities")

    def probability(i: int, label: str):
        if isinstance(probs, list):
            hit = next((x for x in probs if isinstance(x, dict) and (
                (is_int(x.get("value")) and x["value"] == i) or str(x.get("value")) == label or x.get("label") == label)), None)
            found = hit.get("probability") if hit else None
            return found if found is not None else (probs[i] if i < len(probs) else None)
        if isinstance(probs, dict):
            return probs.get(label)
        return None

    if probs is not None:
        p = [num(probability(i, label)) for i, (label, _) in enumerate(DECISION_LEVELS)]
        if any(x is None or not 0 <= x <= 1 for x in p) or all(x == 0 for x in p):
            return None
        return max(range(len(p)), key=lambda i: p[i])  # the first level wins a tie
    score = num(a.get("score"))
    return None if score is None or not 0 <= score <= 3 else int(score + 0.5)


# ───────────────────────── http ─────────────────────────

app = create_app()
upstream = Upstream(timeout=TIMEOUT)
send = upstream.send  # module-level so the tests can swap in a mock


@app.get("/api/config")
async def get_config():
    modes = {
        "webiq": " · ".join(x for x in (WEBIQ_FORMAT, WEBIQ_SAFE_SEARCH and f"safeSearch {WEBIQ_SAFE_SEARCH}") if x),
        "tavily": TAVILY_DEPTH, "exa": EXA_TYPE, "serpapi": "no_cache" if SERPAPI_NO_CACHE else "cached",
    }
    providers = [
        {
            "id": p.id, "label": p.label, "vendor": p.vendor, "envPrefix": p.env_prefix, "host": safe_host(p.base_url),
            "pricePer1k": p.price_per_1k, "signup": p.signup, "ready": not p.problems(), "problems": p.problems(),
            "mode": p.mode or modes.get(p.id),
        }
        for p in PROVIDERS
    ]
    ready = any(p["ready"] for p in providers)
    return reply({
        "ready": ready,
        "problems": [] if ready else ["No search service is configured in webiq/.env"],
        "providers": providers,
        "judges": judge_list(),
        "defaultJudge": DEFAULT_JUDGE,
        "markets": list(MARKETS),
        "hubUrl": HUB_URL,
    })


@app.post("/api/search")
async def search(request: Request):
    body = await read_json(request)
    p = find_provider(body)
    if not p:
        return reply({"ok": False, "error": "Unknown search service"}, 400)
    problems = p.problems()
    if problems:
        return reply({"ok": False, "provider": p.id, "notConfigured": True, "error": "; ".join(problems)})
    invalid = validate_search(body)
    if invalid:
        return reply({"ok": False, "provider": p.id, "error": invalid}, 400)

    q = query_of(body)
    try:
        call, r = await run_search(p, q)
    except UpstreamError as exc:
        return reply({"ok": False, "provider": p.id, "error": f"Could not reach {safe_host(p.base_url)}: {exc}"})
    data = r.data
    wire = {
        "endpoint": f"{call.method} {redact_url(call.url)}",
        "request": call.body if call.body is not None else redact_params(call.url),
        "response": shorten(data) if data is not None else r.text[:4000],
    }
    if not r.ok:
        error = search_error(p, r.status, data, r.text)
        print(f"[{p.id}] {r.status} {error}")
        return reply({"ok": False, "provider": p.id, "status": r.status, "latencyMs": r.timing["totalMs"], "timing": r.timing, "error": error, **wire})

    parsed = [x for x in SERVICES[p.service].parse(data, q) if isinstance(x.get("url"), str)]
    results = [result_of(x, q) for x in parsed[:q.count]]
    context_chars = sum(len(x["content"]) for x in results)

    print(f"[{p.id}] {r.status} {r.timing['totalMs']}ms {len(results)} results {context_chars} chars")
    return reply({
        "ok": True,
        "provider": p.id,
        "status": r.status,
        "latencyMs": r.timing["totalMs"],
        "timing": r.timing,
        "results": results,
        "contextChars": context_chars,
        "freshIntent": SERVICES[p.service].fresh_intent(data),
        "cost": search_cost(p, data),
        **wire,
    })


@app.post("/api/speedtest")
async def speedtest(request: Request):
    body = await read_json(request)
    p = find_provider(body)
    if not p:
        return reply({"ok": False, "error": "Unknown search service"}, 400)
    problems = p.problems()
    if problems:
        return reply({"ok": False, "provider": p.id, "notConfigured": True, "error": "; ".join(problems)})
    invalid = validate_search(body)
    if invalid:
        return reply({"ok": False, "provider": p.id, "error": invalid}, 400)
    runs = num(body.get("runs"))
    n = min(MAX_SPEED_RUNS, max(1, int(runs) if runs else 10))
    q = query_of(body)

    latencies, cost = [], 0.0
    # The first call opens the connection and is not counted, so every measured call runs on a warm socket.
    for i in range(n + 1):
        try:
            _, r = await run_search(p, q)
        except UpstreamError as exc:
            return reply({"ok": False, "provider": p.id, "latencies": latencies, "error": f"Could not reach {safe_host(p.base_url)}: {exc}"})
        if not r.ok:
            return reply({"ok": False, "provider": p.id, "latencies": latencies, "status": r.status, "error": search_error(p, r.status, r.data, r.text)})
        if i > 0:
            latencies.append(r.timing["totalMs"])
        cost += search_cost(p, r.data)
    print(f"[{p.id}] speed test {n} runs: {', '.join(map(str, latencies))} ms")
    return reply({"ok": True, "provider": p.id, "latencies": latencies, "roundTripMs": upstream.round_trips.get(safe_host(p.base_url)), "cost": cost})


@app.post("/api/relevance")
async def relevance(request: Request):
    body = await read_json(request, 4_000_000) or {}
    judge_id = body.get("judge") or DEFAULT_JUDGE
    judge = next((j for j in judge_list() if j["id"] == judge_id), None)
    if not judge:
        return reply({"ok": False, "error": f'Unknown judge "{judge_id}"'}, 400)
    if not judge["ready"]:
        return reply({"ok": False, "notConfigured": True, "error": "; ".join(judge["problems"])})
    question = body["question"].strip() if isinstance(body.get("question"), str) else ""
    if not question:
        return reply({"ok": False, "error": "The question is empty"}, 400)
    if not isinstance(body.get("lanes"), list):
        return reply({"ok": False, "error": "lanes must be an array"}, 400)

    docs, lanes = pool_documents(body["lanes"])
    if not docs:
        return reply({"ok": True, "judge": judge["id"], "latencyMs": 0, "documents": 0,
                      "lanes": {lane["id"]: [{"grade": 0, "dup": True} for _ in lane["items"]] for lane in lanes}})

    random.shuffle(docs)  # so a document's position doesn't reveal which service returned it
    for i, doc in enumerate(docs):
        doc.n = i + 1
    listed = "\n\n".join("\n".join([f"[{d.n}] {d.title}", d.url, *([d.date] if d.date else []), d.text or "(no excerpt)"]) for d in docs)
    text = f"Now: {now_for_judge()}\n\nQuestion: {question}\n\nDocuments:\n\n{listed}"

    started = time.perf_counter()
    if judge["kind"] == "llm":
        r = await grade_with_llm(text, docs)
    else:
        r = await grade_with_decision(next(d for d in DECISION_JUDGES if d.id == judge["id"]), text, docs)
    latency = int((time.perf_counter() - started) * 1000 + 0.5)
    if not r["ok"]:
        return reply({"ok": False, "judge": judge["id"], "status": r.get("status"), "error": r["error"]})
    grades = r["grades"]

    batches = f" in {r['requests']} requests" if r["requests"] > 1 else ""
    print(f"[relevance:{judge['id']}] {latency}ms {len(docs)} documents{batches}")
    return reply({
        "ok": True,
        "judge": judge["id"],
        "latencyMs": latency,
        "documents": len(docs),
        "usage": r.get("usage"),
        "lanes": {
            lane["id"]: [{"grade": 0, "dup": True} if "dup" in item else {"grade": grades.get(item["doc"].n)} for item in lane["items"]]
            for lane in lanes
        },
    })


def upstream_error(key_var: str, url_var: str, status: int, data, text: str, model: str = "", model_var: str = "") -> str:
    msg = upstream_message(status, data, text)
    if status in (401, 403):
        hint = f" Check {key_var} in .env."
    elif status == 404:
        hint = f' Check {url_var}, and that "{model}" ({model_var}) is a deployment in that resource.' if model else f" Check {url_var}."
    elif status == 402:
        hint = " The account is out of credits."
    elif status == 429:
        hint = " Rate limit or quota reached. Wait a moment and try again."
    elif model and status in (400, 422) and re.search(r"model|deployment", msg, re.I):
        hint = f' Check that "{model}" ({model_var}) is the right deployment name.'
    else:
        hint = ""
    return with_hint(msg, hint)


# ───────────────────────── helpers ─────────────────────────


def is_int(value) -> bool:
    """A JSON integer: 3 or 3.0, but not "3", 1.5, or true."""
    return not isinstance(value, bool) and (isinstance(value, int) or (isinstance(value, float) and value.is_integer()))


def first(r: dict, *keys):
    """The first of these fields that is present (JavaScript's a ?? b ?? c)."""
    return next((r[k] for k in keys if r.get(k) is not None), None)


def records(data, *keys) -> list[dict]:
    """The first of these fields that is a list, keeping only its objects."""
    for k in keys:
        value = dig(data, k)
        if isinstance(value, list):
            return [r for r in value if isinstance(r, dict)]
    return []


def pick_date(r: dict, fields: list[tuple[str, str]]) -> dict:
    """The first date field present, with what kind of date it is (published, updated, or crawled)."""
    for key, kind in fields:
        value = r.get(key)
        if isinstance(value, str) and value.strip():
            return {"date": as_utc(value.strip()), "dateKind": kind}
    return {"date": None, "dateKind": None}


def iso(dt: datetime) -> str:
    """An ISO date-time in UTC with milliseconds, as the browser's Date.toISOString() writes it."""
    dt = dt.astimezone(timezone.utc)
    return f"{dt:%Y-%m-%dT%H:%M:%S}.{dt.microsecond // 1000:03d}Z"


def calendar_day(year: int, month: int, day: int) -> datetime:
    """Midnight UTC; a day past the end of the month rolls into the next, as Date.UTC does."""
    return datetime(year, month, 1, tzinfo=timezone.utc) + timedelta(days=day - 1)


def url_date(url: str) -> dict | None:
    """The publication date a URL carries: an arXiv ID (YYMM.NNNNN, month only), or /YYYY/MM/DD/ or /YYYY/MM/ in the path.
    A month-only date is the 1st of the month, so it never makes a page look newer than it is. Future dates are ignored."""
    u = parse_url(url)
    if not u:
        return None

    def make(year: int, month: int, day: int | None = None):
        if not (1 <= month <= 12 and (day is None or 1 <= day <= 31) and year >= 1995):
            return None
        t = calendar_day(year, month, day or 1)
        if t > datetime.now(timezone.utc) + timedelta(days=1):
            return None
        return {"date": iso(t), **({"month": True} if day is None else {})}

    arxiv = re.search(r"(^|\.)arxiv\.org$", u.hostname) and re.match(r"/(?:abs|html|pdf)/(\d\d)(\d\d)\.\d{4,5}", u.path)
    if arxiv:
        return make(2000 + int(arxiv[1]), int(arxiv[2]))
    day = re.search(r"/((?:19|20)\d\d)[/-](\d\d?)[/-](\d\d?)(?=[/\-_.]|$)", u.path)
    if day:
        return make(int(day[1]), int(day[2]), int(day[3]))
    month = re.search(r"/((?:19|20)\d\d)/(\d\d)/", u.path)
    return make(int(month[1]), int(month[2])) if month else None


def as_utc(s: str) -> str:
    """A date-time with no zone (Web IQ's lastUpdatedAt) would be read in the viewer's local time; treat it as UTC."""
    return f"{s}Z" if re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?", s) else s


# Google shows "3 days ago" for recent pages; display_date turns that into an ISO date so it sorts and ages like the others.
AGO_SECONDS = {
    "min": 60, "minute": 60, "hour": 3600, "hr": 3600, "day": 86400, "week": 604800, "month": 2592000, "year": 31536000,
    "分钟": 60, "小时": 3600, "天": 86400, "周": 604800, "个月": 2592000, "年": 31536000,
}
DAY_FORMATS = ("%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y", "%b %d %Y", "%Y-%m-%d", "%m/%d/%Y", "%d.%m.%Y")


def display_date(s) -> str | None:
    if not isinstance(s, str) or not s.strip():
        return None
    s = s.strip()
    ago = re.search(r"(\d+)\s*(minute|min|hour|hr|day|week|month|year)s?\s+ago", s, re.I) or re.search(r"(\d+)\s*(分钟|小时|天|周|个月|年)前", s)
    if ago:
        return iso(datetime.now(timezone.utc) - timedelta(seconds=int(ago[1]) * AGO_SECONDS[ago[2].lower()]))
    # An absolute date ("Jul 25, 2025", "2025年7月25日") is a calendar day; store it as that day in UTC like the other services.
    zh = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", s)
    if zh:
        return iso(calendar_day(int(zh[1]), int(zh[2]), int(zh[3])))
    for fmt in DAY_FORMATS:
        try:
            parsed = datetime.strptime(s, fmt)
        except ValueError:
            continue
        return iso(datetime(parsed.year, parsed.month, parsed.day, tzinfo=timezone.utc))
    try:
        parsed = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return s
    local = parsed.astimezone() if parsed.tzinfo else parsed
    return iso(datetime(local.year, local.month, local.day, tzinfo=timezone.utc))


def strip_tags(s):
    if not isinstance(s, str):
        return s
    return re.sub(r"<[^>]+>", "", s).replace("&quot;", '"').replace("&#39;", "'").replace("&amp;", "&")


def clean(s) -> str:
    return re.sub(r"\s+", " ", s).strip() if isinstance(s, str) else ""


def now_for_judge() -> str:
    """The judge's clock: UTC with the weekday, so "today" and "this week" can be placed (a run from Asia is already tomorrow there)."""
    now = datetime.now(timezone.utc)
    ny = now.astimezone(ZoneInfo("America/New_York"))
    return f"{now:%Y-%m-%d %H:%M} UTC ({now:%A}); New York: {ny:%A} {ny.hour % 12 or 12}:{ny:%M} {ny:%p}"


def clip(s: str, limit: int) -> str:
    """Cut text to at most limit characters, at a word break when one is near, ending in an ellipsis."""
    if not limit or len(s) <= limit:
        return s
    cut = s[:limit - 1]
    space = cut.rfind(" ")
    return f"{(cut[:space] if space > limit * 0.9 else cut).rstrip()}…"


def output_text(data) -> str:
    """The text of a Responses API reply."""
    if isinstance(dig(data, "output_text"), str):
        return data["output_text"]
    output = dig(data, "output")
    items = output if isinstance(output, list) else []
    return "".join(
        str(c.get("text") or "")
        for item in items if isinstance(item, dict) and isinstance(item.get("content"), list)
        for c in item["content"] if isinstance(c, dict) and c.get("type") == "output_text"
    )


def shorten(value, limit: int = 400):
    """Long strings make the wire view unreadable; keep the start of each."""
    if isinstance(value, str):
        return f"{value[:limit]}… ({len(value)} chars)" if len(value) > limit else value
    if isinstance(value, list):
        return [shorten(v, limit) for v in value]
    if isinstance(value, dict):
        return {k: shorten(v, limit) for k, v in value.items()}
    return value


def normalize_url(raw) -> str:
    """Same page, however a service spells the URL: no scheme, www, trailing slash, fragment, or utm_ parameters."""
    u = parse_url(raw)
    if not u:
        return "" if raw is None else str(raw)
    query = u.query
    pairs = parse_qsl(query, keep_blank_values=True)
    if any(k.lower().startswith("utm_") for k, _ in pairs):
        query = urlencode([(k, v) for k, v in pairs if not k.lower().startswith("utm_")])
    host = re.sub(r"^www\.", "", safe_host(raw), flags=re.I).lower()
    return f"{host}{u.path.rstrip('/')}{'?' + query if query else ''}"


SECRET_PARAM = r"key|api_key|apikey|token"


def redact_url(url: str) -> str:
    return re.sub(rf"([?&](?:{SECRET_PARAM})=)[^&]+", r"\1…", url, flags=re.I)


def redact_params(url: str) -> dict:
    query = url.split("?", 1)[1] if "?" in url else ""
    return {k: "…" if re.fullmatch(SECRET_PARAM, k, re.I) else v for k, v in parse_qsl(query, keep_blank_values=True)}


# ───────────────────────── start ─────────────────────────

if __name__ == "__main__":
    lines = ["Web IQ demo", f"▸ Open      http://localhost:{PORT}"]
    for p in PROVIDERS:
        problems = p.problems()
        lines.append(f"▸ {p.label:<18} {'⚠ ' + '; '.join(problems) if problems else p.base_url}")
    for j in judge_list():
        where = f"{j['host']}  model {j['model']}" if j["ready"] else f"⚠ {'; '.join(j['problems'])}"
        lines.append(f"▸ {'Judge: ' + j['label']:<30} {where}{'  (default)' if j['id'] == DEFAULT_JUDGE else ''}")
    serve(app, PORT, ROOT / "public", lines)
