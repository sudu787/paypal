import { z, type ZodType } from "zod";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";
import { toGeminiSchema as toJsonSchema, type ProviderResult } from "@/server/ai/gemini";

// OpenRouter chat completions (openrouter.ai/docs, read 2026-11-12). OpenAI-compatible.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// ponytail: fixed headroom for hidden reasoning; make it configurable if a slower model needs more.
const REASONING_HEADROOM_TOKENS = 8000;

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }).passthrough(), finish_reason: z.string().nullable().optional() }).passthrough()).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).passthrough().optional(),
}).passthrough();

// Some models wrap JSON in a Markdown fence even when asked for a schema. Exported for tests.
export function stripJsonFence(text: string) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

export async function callOpenRouter<T>(input: { system: string; prompt: string; schema: ZodType<T>; maxTokens: number }): Promise<ProviderResult<T>> {
  if (!env.OPENROUTER_API_KEY) throw new AppError("AI_UNAVAILABLE", "Live AI is not configured. Add an OpenRouter API key or switch to replay mode.", 503);
  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "X-Title": "HoldFast" },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        messages: [{ role: "system", content: input.system }, { role: "user", content: input.prompt }],
        // Reasoning models spend hidden reasoning tokens from max_tokens; without headroom the answer is truncated ("length").
        max_tokens: input.maxTokens + REASONING_HEADROOM_TOKENS,
        reasoning: { effort: "low", exclude: true },
        response_format: { type: "json_schema", json_schema: { name: "result", strict: false, schema: toJsonSchema(input.schema) } },
        // Route only to endpoints that honour response_format.
        provider: { require_parameters: true },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new AppError("AI_UNAVAILABLE", "The assistant is temporarily unavailable. You can retry this action.", 503);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // OpenRouter's error body names the cause; it never echoes the key.
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    logger.warn({ event: "openrouter_request_failed", http_status: response.status, provider_message: String(error?.message ?? "").slice(0, 300), model: env.OPENROUTER_MODEL });
    if (response.status === 429) throw new AppError("RATE_LIMITED", "The AI provider's rate limit was reached. Try again later.", 429);
    if ([400, 401, 402, 403].includes(response.status)) throw new AppError("AI_UNAVAILABLE", "Live AI is not available: OpenRouter rejected this app's key, model, or request. Retrying will not help; the operator must fix the configuration or switch to replay mode.", 503);
    throw new AppError("AI_UNAVAILABLE", `The AI provider returned HTTP ${response.status}. You can retry this action.`, 503);
  }
  const parsed = completionSchema.safeParse(payload);
  if (!parsed.success) throw new AppError("AI_UNAVAILABLE", "The assistant returned no structured result.", 503);
  const choice = parsed.data.choices[0]!;
  const finish = choice.finish_reason ?? "unknown";
  if (finish === "length") throw new AppError("AI_UNAVAILABLE", "The assistant did not complete its answer (length).", 503);
  let json: unknown;
  try { json = JSON.parse(stripJsonFence(choice.message.content ?? "")); } catch { throw new AppError("AI_UNAVAILABLE", "The assistant returned no structured result.", 503); }
  const output = input.schema.safeParse(json);
  if (!output.success) throw new AppError("AI_UNAVAILABLE", "The assistant's answer did not match the required structure.", 503);
  return { output: output.data, inputTokens: parsed.data.usage?.prompt_tokens ?? 0, outputTokens: parsed.data.usage?.completion_tokens ?? 0, stopReason: finish };
}
