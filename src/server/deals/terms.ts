import { randomUUID } from "node:crypto";

type Criterion = { criterion_id: string; text: string };
type MilestoneState = { workStatus: string; authorizationStatus: string; captureStatus: string };

export function isTermsEditable(status: string, milestones: readonly MilestoneState[]) {
  return ["TERMS_PROPOSED", "NEGOTIATION_FAILED", "ACTIVE"].includes(status)
    && milestones.every((milestone) => milestone.workStatus === "NOT_STARTED"
      && milestone.authorizationStatus === "NONE"
      && milestone.captureStatus === "NONE");
}

export function preserveCriterionIds(
  previous: readonly Criterion[],
  nextTexts: readonly string[],
  createId: () => string = randomUUID,
) {
  const used = new Set<string>();
  return nextTexts.map((text) => {
    const unchanged = previous.find((criterion) => criterion.text.trim() === text.trim() && !used.has(criterion.criterion_id));
    const criterionId = unchanged?.criterion_id ?? createId();
    used.add(criterionId);
    return { criterion_id: criterionId, text };
  });
}
