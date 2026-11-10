import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { agentRuns, negotiationTurns, termsSnapshots, milestones, auditEvents, deals, mandates, users } from "@/server/db/schema";
import { getDatabase } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { agentTurnSchema, type AgentTurn, type TermSheet } from "@/server/ai/schemas";
import { negotiationSystem, NEGOTIATION_PROMPT_VERSION } from "@/server/ai/prompts";
import { validateTermSheet, type Mandate } from "@/server/ai/guards";
import { runStructured } from "@/server/ai/client";
import replay from "../../../fixtures/ai/negotiation.json";

type Party = { role: "client" | "freelancer"; userId: string; name: string; mandate: Mandate & { priorities: string; preferredMilestones: number | null } };
type PublicTurn = { speaker: string; action: string; message: string; terms: TermSheet | null };

function serializeTerms(rows: Array<typeof milestones.$inferSelect>, revisionRounds: number): TermSheet {
  const items = rows.map((row) => ({ title: row.title, description: row.description, acceptance_criteria: row.acceptanceCriteria.map((item) => item.text), amount_cents: row.amountCents, due_in_days: row.dueInDays }));
  return { milestones: items, total_cents: items.reduce((sum, item) => sum + item.amount_cents, 0), revision_rounds: revisionRounds, notes: "" };
}

function makePrompt(input: { role: Party["role"]; party: Party; brief: string; transcript: PublicTurn[]; initialTerms?: TermSheet; correction?: string }) {
  return JSON.stringify({
    you_represent: input.role,
    private_mandate: { ...input.party.mandate },
    shared_project_brief: input.brief,
    initial_shared_terms: input.initialTerms ?? null,
    shared_transcript: input.transcript.map(({ speaker, action, message, terms }) => ({ speaker, action, message, terms })),
    correction_from_deterministic_validator: input.correction ?? null,
    instructions: "Do not quote or disclose any numeric private mandate. Your public message is shared with both people. For accept, terms must be null.",
  });
}

function validateTurn(turn: AgentTurn, party: Party, latestProposal: { speaker: string; terms: TermSheet } | null, originalTerms: TermSheet) {
  if (turn.message.trim().length < 1 || turn.message.length > 600) return "Keep the public message between 1 and 600 characters.";
  if (turn.action === "propose") {
    if (!turn.terms) return "A proposal must include a full term sheet.";
    return validateTermSheet(turn.terms, party.mandate);
  }
  if (turn.terms !== null) return "For accept or walk_away, terms must be null.";
  if (turn.action === "accept") {
    if (!latestProposal || latestProposal.speaker === party.role) return "You can accept only the other party's latest proposal.";
    return validateTermSheet(latestProposal.terms, party.mandate);
  }
  void originalTerms;
  return null;
}

async function storeTurn(input: { dealId: string; runId: string; runNumber: number; seq: number; role: string; turn: AgentTurn; mode: "live" | "replay"; model: string }) {
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  await db.insert(negotiationTurns).values({ dealId: input.dealId, runId: input.runId, runNumber: input.runNumber, seq: input.seq, speaker: input.role, action: input.turn.action, message: input.turn.message, terms: input.turn.terms as Record<string, unknown> | null });
  if (input.mode === "replay") await db.insert(agentRuns).values({ runId: input.runId, dealId: input.dealId, kind: "NEGOTIATION", agentRole: input.role, model: input.model, promptVersion: NEGOTIATION_PROMPT_VERSION, mode: "replay", inputTokens: 0, outputTokens: 0, latencyMs: 0, stopReason: "end_turn", status: "SUCCEEDED", output: input.turn as unknown as Record<string, unknown> });
}

export async function negotiateDeal(dealId: string, actorUserId: string) {
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const setup = await db.transaction(async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("update").limit(1);
    if (!deal || (deal.clientId !== actorUserId && deal.freelancerId !== actorUserId)) throw new AppError("NOT_FOUND", "Agreement not found.", 404);
    if (!deal.freelancerId) throw new AppError("CONFLICT", "The freelancer must join before negotiation starts.", 409);
    if (!["TERMS_PROPOSED", "NEGOTIATION_FAILED"].includes(deal.status) || deal.clientSignedVersion || deal.freelancerSignedVersion) throw new AppError("CONFLICT", "These terms can no longer be negotiated.", 409);
    const rows = await tx.select().from(milestones).where(eq(milestones.dealId, dealId)).orderBy(milestones.idx);
    if (rows.some((row) => row.authorizationStatus !== "NONE" || row.captureStatus !== "NONE" || row.workStatus !== "NOT_STARTED")) throw new AppError("CONFLICT", "Negotiation cannot replace terms after milestone work or payment has started.", 409);
    const mandateRows = await tx.select().from(mandates).where(eq(mandates.dealId, dealId));
    const clientMandate = mandateRows.find((item) => item.role === "client");
    const freelancerMandate = mandateRows.find((item) => item.role === "freelancer");
    if (!clientMandate || !freelancerMandate) throw new AppError("CONFLICT", "Both private mandates are required.", 409);
    const [client] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, deal.clientId)).limit(1);
    const [freelancer] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, deal.freelancerId)).limit(1);
    const [lastRun] = await tx.select({ runNumber: negotiationTurns.runNumber }).from(negotiationTurns).where(eq(negotiationTurns.dealId, dealId)).orderBy(desc(negotiationTurns.runNumber)).limit(1);
    await tx.update(deals).set({ status: "NEGOTIATING", updatedAt: new Date() }).where(eq(deals.id, dealId));
    return {
      deal,
      rows,
      runId: randomUUID(),
      runNumber: (lastRun?.runNumber ?? 0) + 1,
      client: { role: "client" as const, userId: deal.clientId, name: client?.displayName ?? "Client", mandate: { role: "client" as const, maxTotalCents: clientMandate.maxTotalCents, deadlineDays: clientMandate.deadlineDays, minTotalCents: null, earliestDays: null, priorities: clientMandate.priorities, preferredMilestones: null } },
      freelancer: { role: "freelancer" as const, userId: deal.freelancerId!, name: freelancer?.displayName ?? "Freelancer", mandate: { role: "freelancer" as const, maxTotalCents: null, deadlineDays: null, minTotalCents: freelancerMandate.minTotalCents, earliestDays: freelancerMandate.earliestDays, priorities: freelancerMandate.priorities, preferredMilestones: freelancerMandate.preferredMilestones } },
    };
  });

  const originalTerms = serializeTerms(setup.rows, setup.deal.revisionRounds);
  const parties = [setup.client, setup.freelancer];
  const transcript: PublicTurn[] = [];
  let latestProposal: { speaker: string; terms: TermSheet } | null = null;
  let agreedTerms: TermSheet | null = null;
  const mode = env.AI_MODE;
  try {
    for (let seq = 0; seq < 8; seq += 1) {
      const party = parties[seq % 2]!;
      const initialTerms = seq === 0 ? originalTerms : undefined;
      const prompt = makePrompt({ role: party.role, party, brief: setup.deal.brief, transcript, initialTerms });
      let turn: AgentTurn;
      if (mode === "replay") {
        if (seq === 0) turn = { action: "propose", message: replay.client.message, terms: originalTerms };
        else if (latestProposal) turn = { action: "accept", message: replay.freelancer.message, terms: null };
        else turn = { action: "walk_away", message: "The replay profile could not form an acceptable proposal.", terms: null };
      } else {
        turn = await runStructured({ kind: "NEGOTIATION", agentRole: party.role, runId: setup.runId, system: negotiationSystem, prompt, schema: agentTurnSchema, promptVersion: NEGOTIATION_PROMPT_VERSION, maxTokens: 1800, effort: "low" });
      }
      let validation = validateTurn(turn, party, latestProposal, originalTerms);
      if (validation && mode === "live") {
        const retryPrompt = makePrompt({ role: party.role, party, brief: setup.deal.brief, transcript, initialTerms, correction: validation });
        turn = await runStructured({ kind: "NEGOTIATION", agentRole: party.role, runId: setup.runId, system: negotiationSystem, prompt: retryPrompt, schema: agentTurnSchema, promptVersion: `${NEGOTIATION_PROMPT_VERSION}-correction`, maxTokens: 1800, effort: "low" });
        validation = validateTurn(turn, party, latestProposal, originalTerms);
      }
      if (validation) throw new AppError("AI_UNAVAILABLE", `The proposed terms did not pass validation: ${validation}`, 503);
      await storeTurn({ dealId, runId: setup.runId, runNumber: setup.runNumber, seq, role: party.role, turn, mode, model: mode === "live" ? env.ANTHROPIC_MODEL : "replay-fixture" });
      transcript.push({ speaker: party.role, action: turn.action, message: turn.message, terms: turn.action === "propose" ? turn.terms : null });
      if (turn.action === "walk_away") break;
      if (turn.action === "propose") latestProposal = { speaker: party.role, terms: turn.terms! };
      if (turn.action === "accept" && latestProposal) { agreedTerms = latestProposal.terms; break; }
    }
    if (!agreedTerms) {
      await db.transaction(async (tx) => {
        await tx.update(deals).set({ status: "NEGOTIATION_FAILED", updatedAt: new Date() }).where(eq(deals.id, dealId));
        await tx.insert(auditEvents).values({ category: "DEAL", eventType: "NEGOTIATION_FAILED", dealId, actorType: "USER", actorUserId, data: { run_id: setup.runId, mode } });
      });
      return { status: "NEGOTIATION_FAILED", mode, turns: transcript };
    }
    const saved = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("update").limit(1);
      if (!current || current.status !== "NEGOTIATING" || current.termsVersion !== setup.deal.termsVersion) throw new AppError("CONFLICT", "Agreement changed while negotiation was running.", 409);
      await tx.delete(milestones).where(eq(milestones.dealId, dealId));
      const newRows = await tx.insert(milestones).values(agreedTerms!.milestones.map((item, index) => ({
        dealId, idx: index + 1, title: item.title, description: item.description,
        acceptanceCriteria: item.acceptance_criteria.map((text) => ({ criterion_id: randomUUID(), text })),
        amountCents: item.amount_cents, currency: current.currency, dueInDays: item.due_in_days,
      }))).returning();
      const canonical = { title: current.title, brief: current.brief, currency: current.currency, milestones: newRows.map((item) => ({ id: item.id, idx: item.idx, title: item.title, description: item.description, acceptance_criteria: item.acceptanceCriteria, amount_cents: item.amountCents, due_in_days: item.dueInDays })), notes: agreedTerms!.notes };
      const fingerprint = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
      const nextVersion = current.termsVersion + 1;
      await tx.insert(termsSnapshots).values({ dealId, version: nextVersion, canonicalTerms: canonical, fingerprint });
      await tx.update(deals).set({ status: "TERMS_PROPOSED", termsVersion: nextVersion, revisionRounds: agreedTerms!.revision_rounds, clientSignedVersion: null, freelancerSignedVersion: null, clientSignedAt: null, freelancerSignedAt: null, updatedAt: new Date() }).where(eq(deals.id, dealId));
      await tx.insert(auditEvents).values({ category: "DEAL", eventType: "TERMS_PROPOSED_BY_NEGOTIATION", dealId, actorType: "USER", actorUserId, data: { run_id: setup.runId, terms_version: nextVersion, mode, fingerprint } });
      return { version: nextVersion, milestones: newRows };
    });
    return { status: "TERMS_PROPOSED", mode, terms_version: saved.version, turns: transcript, milestones: saved.milestones };
  } catch (error) {
    await db.transaction(async (tx) => {
      await tx.update(deals).set({ status: "NEGOTIATION_FAILED", updatedAt: new Date() }).where(eq(deals.id, dealId));
      await tx.insert(auditEvents).values({ category: "DEAL", eventType: "NEGOTIATION_ERROR", dealId, actorType: "USER", actorUserId, data: { run_id: setup.runId, mode, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" } });
    });
    throw error;
  }
}
