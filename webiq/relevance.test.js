// Relevance regressions with isolated configuration and mocked upstream responses; no keys or network required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';

const serverSource = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const serverScript = new vm.Script(serverSource.slice(serverSource.indexOf('const env =')) + '\nsend = mockSend;');
const score = new vm.Script('const ran = { count: 3 };\n'
  + appSource.slice(appSource.indexOf('function relevanceScore('), appSource.indexOf('function answering('))
  + '\nrelevanceScore;').runInNewContext();

function documents(request) {
  return request.input.split(/(?=^\[\d+\] )/m).filter((part) => /^\[\d+\] /.test(part))
    .map((part) => ({ n: Number(part.match(/^\[(\d+)\]/)[1]), grade: part.includes('ANSWER_PRESENT') ? 3 : 0 }));
}

function llmReply(request, transform = (entries) => entries) {
  return { output_text: JSON.stringify({ grades: transform(documents(request)) }) };
}

function decisionReply(request, transform = (entries) => entries) {
  const names = Array.isArray(request.questions) ? request.questions.map((question) => question.name) : Object.keys(request.questions);
  const entries = transform(names.map((name) => ({ name, type: 'score', probabilities: [0, 0, 0, 1] })));
  return { answers: Array.isArray(request.questions) ? entries : Object.fromEntries(entries.map((entry) => [entry.name, entry])) };
}

function harness(reply = (request) => llmReply(request)) {
  let handler;
  const requests = [];
  const context = vm.createContext({
    URL, URLSearchParams, Buffer, performance,
    process: { env: {
      MODEL_BASE_URL: 'https://mock.invalid', MODEL_API_KEY: 'test-key', JUDGE_MODEL: 'mock-model',
      MS_DECISION_BASE_URL: 'https://mock.invalid', MS_DECISION_API_KEY: 'test-key',
      GPT_DECISION_BASE_URL: 'https://mock.invalid', GPT_DECISION_API_KEY: 'test-key', JEV_API_KEY: 'test-key',
    } },
    http: { Agent: class {}, createServer(listener) { handler = listener; return { on() {}, listen() {} }; } },
    https: { Agent: class {} },
    console: { log() {}, warn() {}, error() {} },
    mockSend: async (url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return { status: 200, text: JSON.stringify(await reply(request)), timing: { totalMs: 1 } };
    },
  });
  serverScript.runInContext(context);
  return {
    requests,
    async grade(lanes, judge = 'llm') {
      const request = Readable.from([Buffer.from(JSON.stringify({ judge, question: 'What is the answer?', lanes }))]);
      request.method = 'POST';
      request.url = '/api/relevance';
      let response;
      await handler(request, {
        writeHead(status) { assert.equal(status, 200); },
        end(body) { response = JSON.parse(body); },
      });
      return response;
    },
  };
}

function source(index, overrides = {}) {
  return { title: `Result ${index}`, url: `https://example.test/${index}`, content: `Fact ${index} ANSWER_PRESENT`, ...overrides };
}

const defaultLanes = [{ id: 'lane', sources: [1, 2, 3].map((index) => source(index)) }];

function assertFailed(result) {
  assert.equal(result.ok, false);
  assert.equal(result.lanes, undefined);
  assert.ok(result.error);
  assert.equal(score({ rel: result }), null);
}

test('shared 300-character prefixes do not merge different evidence in either provider order', async () => {
  const prefix = 'Shared introduction. '.repeat(20);
  const poor = { id: 'poor', sources: [source(1, { content: `${prefix}No answer` })] };
  const good = { id: 'good', sources: [source(1, { content: `${prefix}ANSWER_PRESENT` })] };
  for (const lanes of [[poor, good], [good, poor]]) {
    const result = await harness().grade(lanes);
    assert.equal(result.documents, 2);
    assert.equal(result.lanes.poor[0].grade, 0);
    assert.equal(result.lanes.good[0].grade, 3);
  }
  const distinctPages = await harness().grade([{ id: 'lane', sources: [poor.sources[0], { ...good.sources[0], url: 'https://example.test/other' }] }]);
  assert.deepEqual(distinctPages.lanes.lane, [{ grade: 0 }, { grade: 3 }]);
});

test('identical evidence shares a grade across normalized URLs', async () => {
  const result = await harness().grade([
    { id: 'first', sources: [source(1, { url: 'https://www.example.test/1/?utm_source=test#part' })] },
    { id: 'second', sources: [source(1)] },
  ]);
  assert.equal(result.documents, 1);
  assert.deepEqual(result.lanes.first, result.lanes.second);
});

for (const [label, overrides] of Object.entries({
  title: { title: 'Different title' },
  date: { date: '2026-10-28' },
  dateKind: { dateKind: 'crawled' },
  datePrecision: { dateKind: 'url', dateMonth: true },
  case: { content: 'FACT 1 ANSWER_PRESENT' },
})) {
  test(`different ${label} is preserved across providers`, async () => {
    const original = source(1, { date: '2026-10-27', dateKind: 'published' });
    const result = await harness().grade([{ id: 'first', sources: [original] }, { id: 'second', sources: [{ ...original, ...overrides }] }]);
    assert.equal(result.documents, 2);
  });
}

test('repeated URLs and full excerpts within a provider still score zero', async () => {
  const original = source(1);
  const result = await harness().grade([{ id: 'lane', sources: [original, { ...original, content: 'Another excerpt' }, { ...original, url: 'https://other.test/copy' }] }]);
  assert.deepEqual(result.lanes.lane, [{ grade: 3 }, { grade: 0, dup: true }, { grade: 0, dup: true }]);
  assert.ok(Math.abs(score({ rel: { ok: true, items: result.lanes.lane } }) - 10 / 3) < 1e-12);
});

test('missing search results still lower the score, while an empty result set needs no judge', async () => {
  const mock = harness();
  const result = await mock.grade([{ id: 'lane', sources: [source(1), source(2)] }]);
  assert.ok(Math.abs(score({ rel: { ok: true, items: result.lanes.lane } }) - 20 / 3) < 1e-12);
  const emptyMock = harness();
  const empty = await emptyMock.grade([{ id: 'lane', sources: [] }]);
  assert.equal(empty.ok, true);
  assert.equal(emptyMock.requests.length, 0);
  assert.equal(score({ rel: { ok: true, items: empty.lanes.lane } }), 0);
});

test('grades 3, 2, 1, 0 weigh 3, 1, 0, 0', () => {
  const of = (...grades) => score({ rel: { ok: true, items: grades.map((grade) => ({ grade })) } });
  assert.equal(of(1, 1, 1), 0);
  assert.ok(Math.abs(of(2, 2, 2) - 10 / 3) < 1e-12);
  assert.ok(Math.abs(of(3, 2, 1) - 40 / 9) < 1e-12);
  assert.ok(of(3, 0, 0) > of(1, 1, 1));
});

const invalidLlm = {
  empty: () => [],
  missing: (entries) => entries.slice(0, 1),
  duplicate: (entries) => [...entries, entries[0]],
  unknown: (entries) => entries.map((entry) => ({ ...entry, n: 999 })),
  'string document number': (entries) => entries.map((entry) => ({ ...entry, n: String(entry.n) })),
  'out of range': (entries) => entries.map((entry) => ({ ...entry, grade: 99 })),
  negative: (entries) => entries.map((entry) => ({ ...entry, grade: -1 })),
  fractional: (entries) => entries.map((entry) => ({ ...entry, grade: 1.5 })),
  'numeric string': (entries) => entries.map((entry) => ({ ...entry, grade: '3' })),
  null: (entries) => entries.map((entry) => ({ ...entry, grade: null })),
  'missing grade': (entries) => entries.map((entry) => ({ n: entry.n })),
  'malformed entry': (entries) => [null, ...entries.slice(1)],
  'wrong structure': () => ({}),
};
for (const [label, transform] of Object.entries(invalidLlm)) {
  test(`LLM ${label} grades fail without a numeric score`, async () => {
    assertFailed(await harness((request) => llmReply(request, transform)).grade(defaultLanes));
  });
}

test('valid LLM grades 0 through 3 are preserved', async () => {
  const result = await harness((request) => llmReply(request, (entries) => entries.map((entry) => ({ ...entry, grade: entry.n - 1 })))).grade([{ id: 'lane', sources: [1, 2, 3, 4].map((index) => source(index)) }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.lanes.lane.map((item) => item.grade).sort(), [0, 1, 2, 3]);
});

const invalidDecisions = {
  empty: () => [],
  missing: (entries) => entries.slice(0, 1),
  unknown: (entries) => [...entries, { ...entries[0], name: 'doc999' }],
  refusal: (entries) => entries.map((entry) => ({ ...entry, type: 'refusal' })),
  'zero probabilities': (entries) => entries.map((entry) => ({ ...entry, probabilities: [0, 0, 0, 0] })),
  'negative probability': (entries) => entries.map((entry) => ({ ...entry, probabilities: [-1, 0, 0, 1] })),
  'incomplete probabilities': (entries) => entries.map((entry) => ({ ...entry, probabilities: [0, 1] })),
  'out-of-range score': (entries) => entries.map((entry) => ({ ...entry, probabilities: undefined, score: 99 })),
};
for (const judge of ['microsoft', 'openai', 'jev']) {
  for (const [label, transform] of Object.entries(invalidDecisions)) {
    test(`${judge} ${label} answers fail without a numeric score`, async () => {
      assertFailed(await harness((request) => decisionReply(request, transform)).grade(defaultLanes, judge));
    });
  }
  for (const [label, answer] of Object.entries({
    array: { probabilities: [0.1, 0.2, 0.3, 0.4] },
    map: { probabilities: { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4 } },
    values: { probabilities: [0.1, 0.2, 0.3, 0.4].map((probability, value) => ({ value, probability })) },
    labels: { probabilities: [0.1, 0.2, 0.3, 0.4].map((probability, index) => ({ label: String(index), probability })) },
    score: { probabilities: undefined, score: 2.8 },
  })) {
    test(`${judge} supports valid ${label} answers`, async () => {
      const result = await harness((request) => decisionReply(request, (entries) => entries.map((entry) => ({ ...entry, ...answer })))).grade(defaultLanes, judge);
      assert.equal(result.ok, true);
      assert.equal(score({ rel: { ok: true, items: result.lanes.lane } }), 10);
    });
  }
  test(`${judge} validates all parallel batches before returning scores`, async () => {
    const lanes = [0, 1, 2].map((laneIndex) => ({ id: `lane${laneIndex}`, sources: Array.from({ length: 10 }, (_, index) => source(laneIndex * 10 + index)) }));
    const valid = harness((request) => decisionReply(request));
    const result = await valid.grade(lanes, judge);
    assert.equal(result.ok, true);
    assert.equal(valid.requests.length, 2);
    assert.equal(result.documents, 30);
    assert.ok(Object.values(result.lanes).flat().every((item) => item.grade === 3));
    const invalid = harness((request) => decisionReply(request, (entries) => entries.length === 10 ? entries.slice(1) : entries));
    assertFailed(await invalid.grade(lanes, judge));
  });
}

test('GPT Decisions rejects duplicate answer names before merging grades', async () => {
  assertFailed(await harness((request) => decisionReply(request, (entries) => [...entries, entries[0]])).grade(defaultLanes, 'openai'));
});