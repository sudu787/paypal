import type { TermSheet } from "@/server/ai/schemas";

export type Mandate = {
  role: "client" | "freelancer";
  maxTotalCents: number | null;
  deadlineDays: number | null;
  minTotalCents: number | null;
  earliestDays: number | null;
};

export function validateTermSheet(terms: TermSheet, mandate: Mandate): string | null {
  if (terms.milestones.length < 1 || terms.milestones.length > 5) return "Use between one and five milestones.";
  if (terms.revision_rounds < 0 || terms.revision_rounds > 3) return "Revision rounds must be from zero through three.";
  if (terms.notes.length > 1000) return "Keep notes below 1000 characters.";
  let sum = 0;
  for (const [index, milestone] of terms.milestones.entries()) {
    if (milestone.title.trim().length < 2 || milestone.title.length > 120) return `Milestone ${index + 1} needs a short title.`;
    if (milestone.description.length > 2000) return `Milestone ${index + 1} description is too long.`;
    if (milestone.acceptance_criteria.length < 1 || milestone.acceptance_criteria.length > 6) return `Milestone ${index + 1} needs one to six acceptance criteria.`;
    if (milestone.acceptance_criteria.some((item) => item.trim().length < 3 || item.length > 200)) return `Milestone ${index + 1} has a criterion outside the allowed length.`;
    if (!Number.isSafeInteger(milestone.amount_cents) || milestone.amount_cents < 100 || milestone.amount_cents > 10_000_000) return `Milestone ${index + 1} amount must be at least $1 and within the supported range.`;
    if (!Number.isSafeInteger(milestone.due_in_days) || milestone.due_in_days < 1 || milestone.due_in_days > 180) return `Milestone ${index + 1} due date must be one to 180 days.`;
    sum += milestone.amount_cents;
  }
  if (!Number.isSafeInteger(sum) || sum !== terms.total_cents) return "total_cents must exactly equal the milestone amounts.";
  if (mandate.role === "client" && (mandate.maxTotalCents === null || mandate.deadlineDays === null || sum > mandate.maxTotalCents || terms.milestones.some((item) => item.due_in_days > mandate.deadlineDays!))) return "The proposal exceeds the client mandate's total budget or deadline.";
  if (mandate.role === "freelancer" && (mandate.minTotalCents === null || mandate.earliestDays === null || sum < mandate.minTotalCents || terms.milestones.at(-1)!.due_in_days < mandate.earliestDays)) return "The proposal is below the freelancer minimum or ends before their earliest available date.";
  return null;
}
