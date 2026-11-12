import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { callGemini, interactionText, toGeminiSchema } from "@/server/ai/gemini";
import { agentTurnSchema, verificationReportSchema } from "@/server/ai/schemas";

const report = {
  criteria: [{ criterion_id: "c1", verdict: "met", evidence: "Menu heading present", reasoning: "Observed" }],
  recommendation: "release",
  confidence: 0.8,
  summary: "All criteria met.",
  injection_suspected: false,
};

function interaction(text: string, status = "completed") {
  return { id: "int-1", status, steps: [{ type: "user_input", content: [{ type: "text", text: "prompt" }] }, { type: "model_output", content: [{ type: "text", text }] }], usage: { total_input_tokens: 120, total_output_tokens: 40 } };
}

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

test("Gemini schema export is plain JSON Schema with enums and nullable terms", () => {
  const schema = toGeminiSchema(agentTurnSchema) as { $schema?: string; properties: Record<string, unknown> };
  assert.equal(schema.$schema, undefined);
  assert.deepEqual((schema.properties.action as { enum: string[] }).enum, ["propose", "accept", "walk_away"]);
  assert.ok(JSON.stringify(schema.properties.terms).includes("null"));
});

test("interaction text is read only from model output steps", () => {
  const { status, text } = interactionText(interaction(JSON.stringify(report)));
  assert.equal(status, "completed");
  assert.deepEqual(JSON.parse(text), report);
  assert.equal(interactionText({ nonsense: true }).status, "invalid");
});

test("callGemini sends the system instruction, JSON schema and key header, and validates the answer", async (t) => {
  const calls = stubFetch(t, interaction(JSON.stringify(report)));
  const result = await callGemini({ system: "You are a reviewer.", prompt: "Review this.", schema: verificationReportSchema });
  assert.deepEqual(result.output, report);
  assert.equal(result.inputTokens, 120);
  assert.equal(result.outputTokens, 40);
  assert.match(calls[0]!.url, /\/v1beta\/interactions$/);
  assert.ok(calls[0]!.headers.get("x-goog-api-key"));
  assert.equal(calls[0]!.body.system_instruction, "You are a reviewer.");
  assert.equal(calls[0]!.body.input, "Review this.");
  assert.equal((calls[0]!.body.response_format as { mime_type: string }).mime_type, "application/json");
});

test("callGemini rejects answers that do not match the required structure", async (t) => {
  stubFetch(t, interaction(JSON.stringify({ ...report, recommendation: "pay_now" })));
  await assert.rejects(callGemini({ system: "s", prompt: "p", schema: verificationReportSchema }), /did not match the required structure/);
});

test("callGemini treats incomplete answers, non-JSON text, and provider errors as unavailable", async (t) => {
  stubFetch(t, interaction("{\"criteria\": [", "incomplete"));
  await assert.rejects(callGemini({ system: "s", prompt: "p", schema: verificationReportSchema }), /did not complete/);
  stubFetch(t, interaction("not json"));
  await assert.rejects(callGemini({ system: "s", prompt: "p", schema: verificationReportSchema }), /no structured result/);
  stubFetch(t, { error: { message: "quota" } }, 429);
  await assert.rejects(callGemini({ system: "s", prompt: "p", schema: verificationReportSchema }), /rate limit/);
});

test("callGemini reports a rejected key or ineligible project as not retryable", async (t) => {
  stubFetch(t, { error: { code: 403, message: "The Gemini API free tier is not available for this project." } }, 403);
  await assert.rejects(callGemini({ system: "s", prompt: "p", schema: verificationReportSchema }), /Retrying will not help/);
});
