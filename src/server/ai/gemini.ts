import { z, type ZodType } from "zod";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";

// Gemini Interactions API (aistudio.google.com/api-reference/interactions-api, read 2026-11-12).
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_API_REVISION = "2026-05-20";

const interactionSchema = z.object({
  status: z.string(),
  steps: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
  output_text: z.string().optional(),
  usage: z.object({ total_input_tokens: z.number().optional(), total_output_tokens: z.number().optional() }).passthrough().optional(),
}).passthrough();

export type ProviderResult<T> = { output: T; inputTokens: number; outputTokens: number; stopReason: string };

// JSON Schema for response_format. Gemini ignores unsupported keywords rather than rejecting them.
export function toGeminiSchema(schema: ZodType) {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

// Extracts the model's text from an interaction. Exported for tests.
export function interactionText(raw: unknown) {
  const parsed = interactionSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", text: "" };
  const fromSteps = (parsed.data.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return { status: parsed.data.status, text: fromSteps || parsed.data.output_text || "", usage: parsed.data.usage };
}

export async function callGemini<T>(input: { system: string; prompt: string; schema: ZodType<T> }): Promise<ProviderResult<T>> {
  if (!env.GEMINI_API_KEY) throw new AppError("AI_UNAVAILABLE", "Live AI is not configured. Add a Gemini API key or switch to replay mode.", 503);
  let response: Response;
  try {
    response = await fetch(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY, "Api-Revision": GEMINI_API_REVISION },
      body: JSON.stringify({
        model: env.GEMINI_MODEL,
        system_instruction: input.system,
        input: input.prompt,
        store: false,
        response_format: { type: "text", mime_type: "application/json", schema: toGeminiSchema(input.schema) },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new AppError("AI_UNAVAILABLE", "The assistant is temporarily unavailable. You can retry this action.", 503);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 429) throw new AppError("RATE_LIMITED", "The AI provider's rate limit was reached. Try again shortly.", 429);
  if (!response.ok) throw new AppError("AI_UNAVAILABLE", `The AI provider returned HTTP ${response.status}. You can retry this action.`, 503);

  const { status, text, usage } = interactionText(payload);
  if (status !== "completed") throw new AppError("AI_UNAVAILABLE", `The assistant did not complete its answer (${status}).`, 503);
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new AppError("AI_UNAVAILABLE", "The assistant returned no structured result.", 503); }
  const output = input.schema.safeParse(json);
  if (!output.success) throw new AppError("AI_UNAVAILABLE", "The assistant's answer did not match the required structure.", 503);
  return { output: output.data, inputTokens: usage?.total_input_tokens ?? 0, outputTokens: usage?.total_output_tokens ?? 0, stopReason: status };
}
