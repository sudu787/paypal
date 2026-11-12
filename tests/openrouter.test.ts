import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { callOpenRouter, stripJsonFence } from "@/server/ai/openrouter";
import { verificationReportSchema } from "@/server/ai/schemas";

const report = {
  criteria: [{ criterion_id: "c1", verdict: "met", evidence: "Menu heading present", reasoning: "Observed" }],
  recommendation: "release",
  confidence: 0.8,
  summary: "All criteria met.",
  injection_suspected: false,
};

const completion = (content: string, finish = "stop") => ({ id: "gen-1", choices: [{ message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 90, completion_tokens: 30 } });

function stubFetch(t: TestContext, body: unknown, status = 200) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json(body, { status });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const call = () => callOpenRouter({ system: "You are a reviewer.", prompt: "Review this.", schema: verificationReportSchema, maxTokens: 500 });

test("callOpenRouter sends a JSON schema request with bearer auth and validates the answer", async (t) => {
  const calls = stubFetch(t, completion(JSON.stringify(report)));
  const result = await call();
  assert.deepEqual(result.output, report);
  assert.equal(result.inputTokens, 90);
  assert.equal(result.outputTokens, 30);
  assert.match(calls[0]!.url, /openrouter\.ai\/api\/v1\/chat\/completions$/);
  assert.match(calls[0]!.headers.get("authorization") ?? "", /^Bearer /);
  assert.equal((calls[0]!.body.response_format as { type: string }).type, "json_schema");
  assert.deepEqual(calls[0]!.body.provider, { require_parameters: true });
  assert.equal((calls[0]!.body.messages as { role: string }[])[0]!.role, "system");
});

test("callOpenRouter accepts fenced JSON and rejects off-schema, truncated, and rejected requests", async (t) => {
  assert.equal(stripJsonFence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
  stubFetch(t, completion("```json\n" + JSON.stringify(report) + "\n```"));
  assert.deepEqual((await call()).output, report);
  stubFetch(t, completion(JSON.stringify({ ...report, recommendation: "pay_now" })));
  await assert.rejects(call(), /did not match the required structure/);
  stubFetch(t, completion("{\"criteria\": [", "length"));
  await assert.rejects(call(), /did not complete/);
  stubFetch(t, { error: { code: 429, message: "free-models-per-day" } }, 429);
  await assert.rejects(call(), /rate limit/);
  stubFetch(t, { error: { code: 401, message: "No auth credentials found" } }, 401);
  await assert.rejects(call(), /Retrying will not help/);
});
