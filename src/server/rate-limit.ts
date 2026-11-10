import { AppError } from "@/server/errors";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let operations = 0;

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  if (++operations % 256 === 0) {
    for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    throw new AppError("RATE_LIMITED", "Too many requests. Try again shortly.", 429, {
      retry_after_seconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    });
  }
  bucket.count += 1;
}
