import { z } from "zod";

export const termSheetSchema = z.object({
  milestones: z.array(z.object({
    title: z.string(),
    description: z.string(),
    acceptance_criteria: z.array(z.string()),
    amount_cents: z.number().int(),
    due_in_days: z.number().int(),
  })),
  total_cents: z.number().int(),
  revision_rounds: z.number().int(),
  notes: z.string(),
});

export const agentTurnSchema = z.object({
  action: z.enum(["propose", "accept", "walk_away"]),
  message: z.string(),
  terms: termSheetSchema.nullable(),
});

export const verificationReportSchema = z.object({
  criteria: z.array(z.object({
    criterion_id: z.string(),
    verdict: z.enum(["met", "not_met", "unclear"]),
    evidence: z.string(),
    reasoning: z.string(),
  })),
  recommendation: z.enum(["release", "revise", "escalate"]),
  confidence: z.number(),
  summary: z.string(),
  injection_suspected: z.boolean(),
});

export type TermSheet = z.infer<typeof termSheetSchema>;
export type AgentTurn = z.infer<typeof agentTurnSchema>;
export type VerificationReport = z.infer<typeof verificationReportSchema>;
