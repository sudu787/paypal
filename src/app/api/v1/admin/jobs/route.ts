import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute } from "@/server/http";
import { requireAdmin } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { durableJobs } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { retryFailedJob } from "@/server/jobs/worker";

export const GET = apiRoute(async (request) => {
  await requireAdmin();
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const status = new URL(request.url).searchParams.get("status");
  if (status && !["QUEUED", "RUNNING", "RETRY", "DONE", "FAILED"].includes(status)) throw new AppError("VALIDATION_ERROR", "Invalid job status.", 400);
  const rows = await db.select({
    id: durableJobs.id,
    kind: durableJobs.kind,
    resourceId: durableJobs.resourceId,
    status: durableJobs.status,
    attempts: durableJobs.attempts,
    maxAttempts: durableJobs.maxAttempts,
    runAfter: durableJobs.runAfter,
    leaseOwner: durableJobs.leaseOwner,
    leaseExpiresAt: durableJobs.leaseExpiresAt,
    lastError: durableJobs.lastError,
    createdAt: durableJobs.createdAt,
    updatedAt: durableJobs.updatedAt,
  }).from(durableJobs)
    .where(status ? eq(durableJobs.status, status) : undefined)
    .orderBy(desc(durableJobs.updatedAt)).limit(100);
  return Response.json({ jobs: rows });
});

const retrySchema = z.object({ job_id: z.uuid() });

export const POST = apiRoute(async (request) => {
  await requireAdmin();
  const body = retrySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) throw new AppError("VALIDATION_ERROR", "job_id must be a UUID.", 400);
  try {
    const job = await retryFailedJob(body.data.job_id);
    return Response.json({ job: { id: job.id, kind: job.kind, resource_id: job.resourceId, status: job.status } });
  } catch (error) {
    if (error instanceof Error && error.message === "Failed job not found.") throw new AppError("CONFLICT", error.message, 409);
    throw error;
  }
}, { mutation: true, rateLimit: { key: (request) => `admin-jobs:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 20, windowMs: 60_000 } });
