import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { sql } from "drizzle-orm";
import { env } from "@/server/env";
import { getDatabase } from "@/server/db";
import { agentRuns } from "@/server/db/schema";
import { AppError } from "@/server/errors";

let anthropic: Anthropic | undefined;
function getClient() {
  if (!env.ANTHROPIC_API_KEY) throw new AppError("AI_UNAVAILABLE", "Live AI is not configured. Switch to replay mode or add an Anthropic API key.", 503);
  anthropic ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 });
  return anthropic;
}

function currentDayUtc() { return new Date().toISOString().slice(0, 10); }

async function reserveBudget(amountMicroUsd: number) {
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is required for the AI spend guard.", 503);
  const date = currentDayUtc();
  const ceiling = Math.floor(env.AI_DAILY_BUDGET_USD * 1_000_000);
  const result = await db.execute(sql`INSERT INTO ai_daily_budget (budget_date, spent_micro_usd, request_count)
    VALUES (${date}, ${amountMicroUsd}, 1)
    ON CONFLICT (budget_date) DO UPDATE
    SET spent_micro_usd = ai_daily_budget.spent_micro_usd + EXCLUDED.spent_micro_usd,
        request_count = ai_daily_budget.request_count + 1,
        updated_at = now()
    WHERE ai_daily_budget.spent_micro_usd + EXCLUDED.spent_micro_usd <= ${ceiling}
    RETURNING budget_date`);
  if (result.length === 0) throw new AppError("RATE_LIMITED", "The daily AI spend limit has been reached.", 429);
  return date;
}

async function adjustBudget(date: string, adjustmentMicroUsd: number) {
  const db = getDatabase();
  if (!db || adjustmentMicroUsd === 0) return;
  await db.execute(sql`UPDATE ai_daily_budget SET spent_micro_usd = greatest(0, spent_micro_usd + ${adjustmentMicroUsd}), updated_at = now() WHERE budget_date = ${date}`);
}

export async function runStructured<T>(input: {
  kind: string;
  agentRole: string;
  runId: string;
  dealId?: string;
  milestoneId?: string;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  promptVersion: string;
  maxTokens?: number;
  effort?: "low" | "medium";
}) {
  if (env.AI_MODE !== "live") throw new AppError("AI_UNAVAILABLE", "Live AI requests are disabled in replay mode.", 503);
  const client = getClient();
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is required for AI run logging.", 503);
  const maxTokens = input.maxTokens ?? 1800;
  const messages = [{ role: "user" as const, content: input.prompt }];
  let counted: Awaited<ReturnType<typeof client.messages.countTokens>>;
  try { counted = await client.messages.countTokens({ model: env.ANTHROPIC_MODEL, system: input.system, messages }); }
  catch { throw new AppError("AI_UNAVAILABLE", "The assistant is temporarily unavailable. You can retry this action.", 503); }
  if (counted.input_tokens > 10_000) throw new AppError("VALIDATION_ERROR", "This AI request exceeds the configured context limit.", 400);
  const reservedMicro = Math.ceil((counted.input_tokens + 1000) * env.AI_INPUT_PRICE_USD_PER_MTOK + maxTokens * env.AI_OUTPUT_PRICE_USD_PER_MTOK);
  const date = await reserveBudget(reservedMicro);
  const started = Date.now();
  let settled = false;
  try {
    const response = await client.messages.parse({
      model: env.ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: input.system,
      messages,
      output_config: { format: zodOutputFormat(input.schema), effort: input.effort ?? "low" },
    });
    const usage = response.usage;
    const actualMicro = Math.ceil(usage.input_tokens * env.AI_INPUT_PRICE_USD_PER_MTOK + usage.output_tokens * env.AI_OUTPUT_PRICE_USD_PER_MTOK);
    await adjustBudget(date, actualMicro - reservedMicro);
    settled = true;
    const output = response.parsed_output;
    if (response.stop_reason === "refusal" || !output) throw new AppError("AI_UNAVAILABLE", response.stop_reason === "refusal" ? "The assistant declined this request." : "The assistant returned no structured result.", 503);
    await db.insert(agentRuns).values({ runId: input.runId, dealId: input.dealId, milestoneId: input.milestoneId, kind: input.kind, agentRole: input.agentRole, model: env.ANTHROPIC_MODEL, promptVersion: input.promptVersion, mode: "live", inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, latencyMs: Date.now() - started, stopReason: response.stop_reason, status: "SUCCEEDED", output: output as Record<string, unknown> });
    return output;
  } catch (error) {
    if (!settled) await adjustBudget(date, -reservedMicro);
    await db.insert(agentRuns).values({ runId: input.runId, dealId: input.dealId, milestoneId: input.milestoneId, kind: input.kind, agentRole: input.agentRole, model: env.ANTHROPIC_MODEL, promptVersion: input.promptVersion, mode: "live", latencyMs: Date.now() - started, status: "ERROR", error: error instanceof Error ? error.message.slice(0, 500) : "AI provider error" });
    if (error instanceof AppError) throw error;
    throw new AppError("AI_UNAVAILABLE", "The assistant is temporarily unavailable. You can retry this action.", 503);
  }
}
