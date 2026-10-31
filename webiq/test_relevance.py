"""Relevance regressions with isolated configuration and mocked upstream responses; no keys or network required."""

import importlib.util
import json
import os
import re
from itertools import count
from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from demokit import Reply

SERVER = Path(__file__).with_name("server.py")
ENV = {
    "MODEL_BASE_URL": "https://mock.invalid", "MODEL_API_KEY": "test-key", "JUDGE_MODEL": "mock-model",
    "MS_DECISION_BASE_URL": "https://mock.invalid", "MS_DECISION_API_KEY": "test-key",
    "GPT_DECISION_BASE_URL": "https://mock.invalid", "GPT_DECISION_API_KEY": "test-key", "JEV_API_KEY": "test-key",
}
_fresh = count()


def documents(request: dict) -> list[dict]:
    """Every [n] document in the judge's input, graded 3 when it holds the answer and 0 otherwise."""
    parts = re.split(r"(?=^\[\d+\] )", request["input"], flags=re.M)
    return [{"n": int(re.match(r"\[(\d+)\]", p)[1]), "grade": 3 if "ANSWER_PRESENT" in p else 0} for p in parts if re.match(r"\[\d+\] ", p)]


def llm_reply(request, transform=lambda entries: entries):
    return {"output_text": json.dumps({"grades": transform(documents(request))})}


def decision_reply(request, transform=lambda entries: entries):
    questions = request["questions"]
    names = [q["name"] for q in questions] if isinstance(questions, list) else list(questions)
    entries = transform([{"name": name, "type": "score", "probabilities": [0, 0, 0, 1]} for name in names])
    return {"answers": entries if isinstance(questions, list) else {e["name"]: e for e in entries}}


class Harness:
    """A fresh copy of the server, configured only by ENV, with every upstream call answered by reply(request)."""

    def __init__(self, reply=llm_reply):
        with mock.patch.dict(os.environ, ENV, clear=True), mock.patch("demokit.config.read_env_file"):
            spec = importlib.util.spec_from_file_location(f"webiq_server_{next(_fresh)}", SERVER)
            self.server = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.server)
        self.requests = []

        async def send(url, method="GET", headers=None, body=None):
            self.requests.append(body)
            return Reply(200, json.dumps(reply(body)), {"totalMs": 1})

        self.server.send = send
        self.client = TestClient(self.server.app)

    def grade(self, lanes, judge="llm") -> dict:
        response = self.client.post("/api/relevance", json={"judge": judge, "question": "What is the answer?", "lanes": lanes})
        assert response.status_code == 200
        return response.json()


def source(index, **overrides):
    return {"title": f"Result {index}", "url": f"https://example.test/{index}", "content": f"Fact {index} ANSWER_PRESENT", **overrides}


DEFAULT_LANES = [{"id": "lane", "sources": [source(i) for i in (1, 2, 3)]}]


def assert_failed(result):
    """A failed grading has no lanes, so the page shows no relevance score rather than a wrong one."""
    assert result["ok"] is False
    assert "lanes" not in result
    assert result["error"]


def grades(result, lane="lane"):
    return [item["grade"] for item in result["lanes"][lane]]


def test_shared_prefixes_do_not_merge_different_evidence_in_either_provider_order():
    prefix = "Shared introduction. " * 20
    poor = {"id": "poor", "sources": [source(1, content=f"{prefix}No answer")]}
    good = {"id": "good", "sources": [source(1, content=f"{prefix}ANSWER_PRESENT")]}
    for lanes in ([poor, good], [good, poor]):
        result = Harness().grade(lanes)
        assert result["documents"] == 2
        assert result["lanes"]["poor"][0]["grade"] == 0
        assert result["lanes"]["good"][0]["grade"] == 3
    other_page = {**good["sources"][0], "url": "https://example.test/other"}
    distinct = Harness().grade([{"id": "lane", "sources": [poor["sources"][0], other_page]}])
    assert distinct["lanes"]["lane"] == [{"grade": 0}, {"grade": 3}]


def test_identical_evidence_shares_a_grade_across_normalized_urls():
    result = Harness().grade([
        {"id": "first", "sources": [source(1, url="https://www.example.test/1/?utm_source=test#part")]},
        {"id": "second", "sources": [source(1)]},
    ])
    assert result["documents"] == 1
    assert result["lanes"]["first"] == result["lanes"]["second"]


@pytest.mark.parametrize("overrides", [
    {"title": "Different title"},
    {"date": "2026-10-28"},
    {"dateKind": "crawled"},
    {"dateKind": "url", "dateMonth": True},
    {"content": "FACT 1 ANSWER_PRESENT"},
], ids=["title", "date", "dateKind", "datePrecision", "case"])
def test_any_difference_is_preserved_across_providers(overrides):
    original = source(1, date="2026-10-27", dateKind="published")
    result = Harness().grade([{"id": "first", "sources": [original]}, {"id": "second", "sources": [{**original, **overrides}]}])
    assert result["documents"] == 2


def test_repeated_urls_and_full_excerpts_within_a_provider_score_zero():
    original = source(1)
    result = Harness().grade([{"id": "lane", "sources": [original, {**original, "content": "Another excerpt"}, {**original, "url": "https://other.test/copy"}]}])
    assert result["lanes"]["lane"] == [{"grade": 3}, {"grade": 0, "dup": True}, {"grade": 0, "dup": True}]


def test_an_empty_result_set_needs_no_judge():
    harness = Harness()
    result = harness.grade([{"id": "lane", "sources": []}])
    assert result["ok"] is True
    assert result["lanes"]["lane"] == []
    assert harness.requests == []


INVALID_LLM = {
    "empty": lambda entries: [],
    "missing": lambda entries: entries[:1],
    "duplicate": lambda entries: [*entries, entries[0]],
    "unknown": lambda entries: [{**e, "n": 999} for e in entries],
    "string document number": lambda entries: [{**e, "n": str(e["n"])} for e in entries],
    "out of range": lambda entries: [{**e, "grade": 99} for e in entries],
    "negative": lambda entries: [{**e, "grade": -1} for e in entries],
    "fractional": lambda entries: [{**e, "grade": 1.5} for e in entries],
    "numeric string": lambda entries: [{**e, "grade": "3"} for e in entries],
    "null": lambda entries: [{**e, "grade": None} for e in entries],
    "missing grade": lambda entries: [{"n": e["n"]} for e in entries],
    "malformed entry": lambda entries: [None, *entries[1:]],
    "wrong structure": lambda entries: {},
}


@pytest.mark.parametrize("transform", INVALID_LLM.values(), ids=INVALID_LLM.keys())
def test_invalid_llm_grades_fail_without_a_score(transform):
    assert_failed(Harness(lambda request: llm_reply(request, transform)).grade(DEFAULT_LANES))


def test_valid_llm_grades_0_through_3_are_preserved():
    harness = Harness(lambda request: llm_reply(request, lambda entries: [{**e, "grade": e["n"] - 1} for e in entries]))
    result = harness.grade([{"id": "lane", "sources": [source(i) for i in (1, 2, 3, 4)]}])
    assert result["ok"] is True
    assert sorted(grades(result)) == [0, 1, 2, 3]


INVALID_DECISIONS = {
    "empty": lambda entries: [],
    "missing": lambda entries: entries[:1],
    "unknown": lambda entries: [*entries, {**entries[0], "name": "doc999"}],
    "refusal": lambda entries: [{**e, "type": "refusal"} for e in entries],
    "zero probabilities": lambda entries: [{**e, "probabilities": [0, 0, 0, 0]} for e in entries],
    "negative probability": lambda entries: [{**e, "probabilities": [-1, 0, 0, 1]} for e in entries],
    "incomplete probabilities": lambda entries: [{**e, "probabilities": [0, 1]} for e in entries],
    "out-of-range score": lambda entries: [{**e, "probabilities": None, "score": 99} for e in entries],
}
VALID_DECISIONS = {
    "array": {"probabilities": [0.1, 0.2, 0.3, 0.4]},
    "map": {"probabilities": {"0": 0.1, "1": 0.2, "2": 0.3, "3": 0.4}},
    "values": {"probabilities": [{"value": i, "probability": p} for i, p in enumerate([0.1, 0.2, 0.3, 0.4])]},
    "labels": {"probabilities": [{"label": str(i), "probability": p} for i, p in enumerate([0.1, 0.2, 0.3, 0.4])]},
    "score": {"probabilities": None, "score": 2.8},
}
JUDGES = ["microsoft", "openai", "jev"]


@pytest.mark.parametrize("judge", JUDGES)
@pytest.mark.parametrize("transform", INVALID_DECISIONS.values(), ids=INVALID_DECISIONS.keys())
def test_invalid_decision_answers_fail_without_a_score(judge, transform):
    assert_failed(Harness(lambda request: decision_reply(request, transform)).grade(DEFAULT_LANES, judge))


@pytest.mark.parametrize("judge", JUDGES)
@pytest.mark.parametrize("answer", VALID_DECISIONS.values(), ids=VALID_DECISIONS.keys())
def test_decision_judges_accept_every_answer_shape(judge, answer):
    harness = Harness(lambda request: decision_reply(request, lambda entries: [{**e, **answer} for e in entries]))
    result = harness.grade(DEFAULT_LANES, judge)
    assert result["ok"] is True
    assert grades(result) == [3, 3, 3]


@pytest.mark.parametrize("judge", JUDGES)
def test_decision_judges_validate_all_parallel_batches_before_scoring(judge):
    lanes = [{"id": f"lane{lane}", "sources": [source(lane * 10 + i) for i in range(10)]} for lane in range(3)]
    valid = Harness(decision_reply)
    result = valid.grade(lanes, judge)
    assert result["ok"] is True
    assert len(valid.requests) == 2
    assert result["documents"] == 30
    assert all(item["grade"] == 3 for items in result["lanes"].values() for item in items)

    # The 10-question batch drops an answer; the 20-question batch is fine. The whole grading must fail.
    invalid = Harness(lambda request: decision_reply(request, lambda entries: entries[1:] if len(entries) == 10 else entries))
    assert_failed(invalid.grade(lanes, judge))


def test_gpt_decisions_rejects_duplicate_answer_names():
    assert_failed(Harness(lambda request: decision_reply(request, lambda entries: [*entries, entries[0]])).grade(DEFAULT_LANES, "openai"))
