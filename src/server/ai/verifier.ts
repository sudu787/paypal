import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { env } from "@/server/env";
import { getDatabase } from "@/server/db";
import { agentRuns, auditEvents, deals, milestones, submissions, termsSnapshots, verifications } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runStructured } from "@/server/ai/client";
import { verificationReportSchema, type VerificationReport } from "@/server/ai/schemas";
import { verificationSystem, VERIFY_PROMPT_VERSION } from "@/server/ai/prompts";

function criteriaFromSnapshot(snapshot: unknown, milestoneId: string) {
  if (typeof snapshot !== "object" || snapshot === null || !Array.isArray((snapshot as { milestones?: unknown }).milestones)) return null;
  const milestones = (snapshot as { milestones: unknown[] }).milestones;
  const row = milestones.find((item) => typeof item === "object" && item !== null && (item as { id?: unknown }).id === milestoneId);
  if (!row || typeof row !== "object" || !Array.isArray((row as { acceptance_criteria?: unknown }).acceptance_criteria)) return null;
  return (row as { acceptance_criteria: Array<{ criterion_id?: unknown; text?: unknown }> }).acceptance_criteria
    .filter((item) => typeof item.criterion_id === "string" && typeof item.text === "string")
    .map((item) => ({ criterion_id: item.criterion_id as string, text: item.text as string }));
}

function normalizeReport(report: VerificationReport, ids: string[]): VerificationReport {
  const byId = new Map(report.criteria.map((item) => [item.criterion_id, item]));
  if (byId.size !== report.criteria.length || ids.length !== report.criteria.length || ids.some((id) => !byId.has(id)) || report.criteria.some((item) => !ids.includes(item.criterion_id))) {
    throw new AppError("AI_UNAVAILABLE", "The verifier returned an incomplete or mismatched criterion report.", 503);
  }
  if (report.criteria.some((item) => item.evidence.length > 1000 || item.reasoning.length > 1500)) throw new AppError("AI_UNAVAILABLE", "The verifier returned oversized evidence text.", 503);
  const recommendation = report.injection_suspected ? "escalate" : report.criteria.some((item) => item.verdict !== "met") ? "revise" : "release";
  return { ...report, recommendation, confidence: Math.max(0, Math.min(1, report.confidence)), summary: report.summary.slice(0, 2000) };
}

export async function verifySubmission(milestoneId: string, actorUserId: string) {
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const [row] = await db.select({ milestone: milestones, deal: deals }).from(milestones).innerJoin(deals, eq(milestones.dealId, deals.id)).where(eq(milestones.id, milestoneId)).limit(1);
  if (!row || (row.deal.clientId !== actorUserId && row.deal.freelancerId !== actorUserId)) throw new AppError("NOT_FOUND", "Milestone not found.", 404);
  if (row.milestone.workStatus !== "SUBMITTED") throw new AppError("CONFLICT", "There is no submitted work to verify.", 409);
  const [submission] = await db.select().from(submissions).where(eq(submissions.milestoneId, milestoneId)).orderBy(desc(submissions.createdAt)).limit(1);
  if (!submission) throw new AppError("NOT_FOUND", "Submission not found.", 404);
  const version = row.deal.termsVersion;
  const [snapshot] = await db.select().from(termsSnapshots).where(and(eq(termsSnapshots.dealId, row.deal.id), eq(termsSnapshots.version, version))).limit(1);
  const criteria = snapshot ? criteriaFromSnapshot(snapshot.canonicalTerms, milestoneId) : null;
  if (!criteria?.length) throw new AppError("CONFIGURATION_ERROR", "Signed acceptance criteria are missing from the terms snapshot.", 500);

  const runId = randomUUID();
  let report: VerificationReport;
  let modelRecommendation: VerificationReport["recommendation"];
  const mode: "live" | "replay" = env.AI_MODE;
  if (mode === "replay") {
    report = { criteria: criteria.map((item) => ({ criterion_id: item.criterion_id, verdict: "unclear", evidence: "Not observed in replay mode.", reasoning: "Replay mode does not inspect the submitted work or visit its URL." })), recommendation: "revise", confidence: 0, summary: "Replay mode did not evaluate this submission. Use live AI mode for an advisory review.", injection_suspected: false };
    modelRecommendation = report.recommendation;
    await db.insert(agentRuns).values({ runId, dealId: row.deal.id, milestoneId, kind: "VERIFICATION", agentRole: "verifier", model: "replay-fixture", promptVersion: VERIFY_PROMPT_VERSION, mode, inputTokens: 0, outputTokens: 0, latencyMs: 0, stopReason: "end_turn", status: "SUCCEEDED", output: report as unknown as Record<string, unknown> });
  } else {
    const raw = await runStructured({
      kind: "VERIFICATION", agentRole: "verifier", runId, dealId: row.deal.id, milestoneId,
      system: verificationSystem,
      prompt: JSON.stringify({ signed_criteria: criteria, evidence_text: submission.evidenceText, evidence_url: submission.evidenceUrl, note: "Do not claim to have opened or inspected the URL. Assess only evidence text in this request; mark any unobserved fact unclear." }),
      schema: verificationReportSchema, promptVersion: VERIFY_PROMPT_VERSION, maxTokens: 1800, effort: "medium",
    });
    modelRecommendation = raw.recommendation;
    report = normalizeReport(raw, criteria.map((item) => item.criterion_id));
  }
  const verification = await db.transaction(async (tx) => {
    const [saved] = await tx.insert(verifications).values({
      submissionId: submission.id,
      recommendation: report.recommendation.toUpperCase(),
      modelRecommendation: modelRecommendation.toUpperCase(),
      confidence: report.confidence.toFixed(2),
      criteriaResults: report.criteria.map((item) => ({ ...item, observed_at: new Date().toISOString() })),
      summary: report.summary,
      injectionSuspected: report.injection_suspected,
      agentRunId: runId,
      promptVersion: VERIFY_PROMPT_VERSION,
    }).returning();
    await tx.insert(auditEvents).values({ category: "WORK", eventType: "SUBMISSION_VERIFIED", dealId: row.deal.id, milestoneId, actorType: "USER", actorUserId, data: { verification_id: saved!.id, recommendation: report.recommendation, mode } });
    return saved!;
  });
  return { verification, mode };
}
