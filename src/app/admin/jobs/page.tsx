"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";

type Job = {
  id: string;
  kind: string;
  resourceId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  leaseExpiresAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export default function AdminJobsPage() {
  const router = useRouter();
  const [status, setStatus] = useState("FAILED");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/admin/jobs?status=${encodeURIComponent(status)}`);
      const payload = await response.json().catch(() => null);
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not load the job queue.");
      setJobs(payload.jobs ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the job queue.");
    } finally {
      setLoading(false);
    }
  }, [router, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function retry(jobId: string) {
    setRetrying(jobId);
    setError("");
    try {
      const response = await fetch("/api/v1/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not queue this job for retry.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue this job for retry.");
    } finally {
      setRetrying("");
    }
  }

  return <main className="min-h-screen bg-[#f7f8f5]">
    <header className="border-b border-[#e2e9e4] bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8"><Link href="/workspace" className="font-bold text-[#173f36]">holdfast<span className="text-[#17836b]">.</span></Link><Link href="/workspace" className="text-sm font-medium text-[#526c60]"><ArrowLeft className="mr-1 inline" size={15}/>Workspace</Link></div></header>
    <section className="mx-auto max-w-7xl px-5 py-10 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><div className="text-xs font-bold uppercase tracking-[.15em] text-[#147d67]">Operations</div><h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#173f36]">Durable jobs</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#657572]">Inspect webhook and payment recovery work. Retrying a job resumes its stored operation and provider request ID.</p></div>
        <div className="flex items-end gap-2">
          <label className="text-xs font-semibold text-[#526c60]">Status<select value={status} onChange={(event) => setStatus(event.target.value)} className="mt-1 h-11 rounded-xl border border-[#dce5df] bg-white px-3 text-sm font-normal text-[#172c2a]">{["FAILED", "QUEUED", "RETRY", "RUNNING", "DONE"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#dce5df] bg-white px-3 text-sm font-semibold text-[#31574a] disabled:opacity-60"><RefreshCw size={15} className={loading ? "animate-spin" : ""}/>Refresh</button>
        </div>
      </div>
      {error && <p role="alert" className="mt-6 rounded-2xl bg-[#fff2ed] p-4 text-sm text-[#9a412d]">{error}</p>}
      {loading ? <div className="mt-8 flex items-center gap-2 text-sm text-[#657572]"><LoaderCircle size={16} className="animate-spin"/>Loading jobs…</div>
        : jobs.length === 0 ? <div className="mt-8 rounded-2xl border border-dashed border-[#cad8ce] bg-white p-8 text-sm text-[#657572]">No {status.toLowerCase()} jobs.</div>
          : <div className="mt-8 grid gap-3">
            {jobs.map((job) => <article key={job.id} className="rounded-2xl border border-[#e1e9e3] bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-[#173f36]">{job.kind.replaceAll("_", " ").toLowerCase()}</h2><span className="rounded-full bg-[#f4f6f3] px-2.5 py-1 text-[10px] font-semibold uppercase text-[#657572]">{job.status}</span></div><p className="mt-2 break-all font-mono text-[11px] text-[#657572]">Job {job.id} · resource {job.resourceId}</p></div>
                {job.status === "FAILED" && <button type="button" onClick={() => void retry(job.id)} disabled={retrying === job.id} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#147d67] px-4 text-sm font-bold text-white disabled:opacity-60"><RotateCcw size={15}/>{retrying === job.id ? "Queueing…" : "Retry job"}</button>}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#657572]"><span>Attempts: {job.attempts} / {job.maxAttempts}</span><span>Updated: {new Date(job.updatedAt).toLocaleString()}</span>{job.leaseExpiresAt && <span>Lease expires: {new Date(job.leaseExpiresAt).toLocaleString()}</span>}</div>
              {job.lastError && <p className="mt-3 whitespace-pre-wrap rounded-xl bg-[#fff8f4] p-3 text-xs leading-5 text-[#885343]">{job.lastError}</p>}
            </article>)}
          </div>}
      <p className="mt-5 text-xs text-[#82918b]">Provider operation details remain in the application audit trail. A retry never creates a replacement payment operation.</p>
    </section>
  </main>;
}
