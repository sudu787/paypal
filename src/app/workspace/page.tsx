"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, CircleDollarSign, Clock3, Handshake, LoaderCircle, LogOut, Plus, ShieldCheck } from "lucide-react";

type User = { id: string; email: string; displayName: string; role: string };
type Milestone = { id: string; idx: number; title: string; description: string; amountCents: number; workStatus: string; authorizationStatus: string; captureStatus: string; payoutStatus: string; acceptanceCriteria?: Array<{ criterion_id: string; text: string }>; latestSubmission?: { evidenceText: string; evidenceUrl: string | null } | null; verification?: { recommendation: string; summary: string; criteriaResults: Array<{ criterion_id: string; verdict: string; evidence: string }> } | null };
type Deal = { id: string; title: string; brief: string; status: string; currency: string; termsVersion: number; clientId: string; freelancerId: string | null; clientSignedVersion: number | null; freelancerSignedVersion: number | null; milestones: Milestone[]; aiMode?: string | null; negotiationTurns?: Array<{ id: string; speaker: string; action: string; message: string }> };

export default function Workspace() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [meResponse, dealsResponse] = await Promise.all([fetch("/api/v1/me"), fetch("/api/v1/deals")]);
        if (meResponse.status === 401 || dealsResponse.status === 401) { router.replace("/login"); return; }
        const [me, dealPayload] = await Promise.all([meResponse.json(), dealsResponse.json()]);
        if (!meResponse.ok) throw new Error(me?.error?.message ?? "Could not load workspace.");
        if (alive) { setUser(me.user); setDeals(dealPayload.deals ?? []); }
      } catch (caught) { if (alive) setError(caught instanceof Error ? caught.message : "Unable to load workspace."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [router]);

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    router.replace("/"); router.refresh();
  }

  const total = deals.flatMap((deal) => deal.milestones).reduce((sum, item) => sum + item.amountCents, 0);
  return <main className="min-h-screen bg-[#f7f8f5]">
    <header className="border-b border-[#e2e9e4] bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8"><Link href="/" className="flex items-center gap-3 font-bold"><span className="grid size-9 place-items-center rounded-xl bg-[#173f36] text-white"><Handshake size={19}/></span>holdfast<span className="-ml-3 text-[#17836b]">.</span></Link><div className="flex items-center gap-4"><Link href="/ledger" className="text-sm font-semibold text-[#526c60] hover:text-[#147d67]">Ledger</Link><span className="hidden text-sm text-[#657572] sm:inline">{user?.displayName ?? "Workspace"}</span><button onClick={() => void logout()} className="rounded-full border border-[#dce5df] px-3.5 py-2 text-xs font-semibold text-[#42645a] hover:bg-[#f5f8f5]"><LogOut className="mr-1.5 inline" size={14}/>Sign out</button></div></div></header>
    <div className="mx-auto max-w-7xl px-5 py-10 lg:px-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><div className="text-xs font-bold uppercase tracking-[.15em] text-[#147d67]">Your workspace</div><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] text-[#173f36]">Good to see you{user ? `, ${user.displayName.split(" ")[0]}` : ""}.</h1><p className="mt-2 text-sm text-[#657572]">The agreement, milestones, and decisions in one place.</p></div><div className="flex items-center gap-3"><span className="inline-flex items-center gap-2 rounded-full border border-[#cfe6d9] bg-[#eff8f1] px-3.5 py-2 text-xs font-semibold text-[#147d67]"><span className="size-1.5 rounded-full bg-[#27a379]"/>PayPal sandbox</span><button onClick={() => setCreating(true)} className="rounded-full bg-[#147d67] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#106c5a]"><Plus className="mr-1 inline" size={15}/>New agreement</button></div></div>
      {creating && <CreateAgreement onClose={() => setCreating(false)} onCreated={() => window.location.reload()}/>}
      {loading ? <div className="mt-10 flex items-center gap-2 text-sm text-[#657572]"><LoaderCircle className="animate-spin" size={17}/>Loading your agreements…</div> : error ? <div role="alert" className="mt-8 rounded-2xl bg-[#fff2ed] p-5 text-sm text-[#9a412d]">{error}</div> : <>
        <div className="mt-8 grid gap-4 sm:grid-cols-3"><Summary label="Agreements" value={String(deals.length)} icon={<Handshake size={18}/>} /><Summary label="Milestones" value={String(deals.reduce((sum, deal) => sum + deal.milestones.length, 0))} icon={<Check size={18}/>} /><Summary label="Agreed value" value={formatMoney(total, deals[0]?.currency ?? "USD")} icon={<CircleDollarSign size={18}/>} /></div>
        {deals.length === 0 ? <section className="mt-6 rounded-3xl border border-dashed border-[#cad8ce] bg-white px-6 py-14 text-center"><Handshake className="mx-auto text-[#92a79b]" size={28}/><h2 className="mt-4 text-lg font-semibold">No agreements yet</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#657572]">Your agreements will appear here when you create one or join using an invitation.</p></section> : deals.map((deal) => <section key={deal.id} className="mt-6 overflow-hidden rounded-3xl border border-[#e1e9e3] bg-white shadow-[0_6px_25px_#234a3808]"><div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#e8eeea] p-6"><div><div className="flex items-center gap-2"><h2 className="text-xl font-semibold tracking-tight">{deal.title}</h2><span className="rounded-full bg-[#eaf5ee] px-2.5 py-1 text-[11px] font-semibold text-[#147d67]">{deal.status.toLowerCase().replaceAll("_", " ")}</span>{deal.aiMode && <span className="rounded-full bg-[#f2f4ec] px-2.5 py-1 text-[10px] font-semibold text-[#7d7150]">AI {deal.aiMode}</span>}</div><p className="mt-2 max-w-2xl text-sm leading-6 text-[#657572]">{deal.brief}</p><div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-[#657572]"><span className="rounded-full bg-[#f4f6f3] px-2.5 py-1">Client: {deal.clientSignedVersion === deal.termsVersion ? "signed" : "awaiting signature"}</span><span className="rounded-full bg-[#f4f6f3] px-2.5 py-1">Freelancer: {deal.freelancerId ? (deal.freelancerSignedVersion === deal.termsVersion ? "signed" : "awaiting signature") : "invited"}</span>{deal.freelancerId && ["TERMS_PROPOSED", "NEGOTIATION_FAILED"].includes(deal.status) && !deal.clientSignedVersion && !deal.freelancerSignedVersion && <NegotiationButton dealId={deal.id}/ >}{deal.freelancerId && deal.status === "TERMS_PROPOSED" && ((deal.clientId === user?.id && deal.clientSignedVersion !== deal.termsVersion) || (deal.freelancerId === user?.id && deal.freelancerSignedVersion !== deal.termsVersion)) && <button onClick={() => void signTerms(deal.id, deal.termsVersion)} className="rounded-full bg-[#147d67] px-3 py-1.5 font-bold text-white">Sign terms</button>}</div></div><div className="rounded-xl bg-[#f3f7f3] px-3 py-2 text-right"><div className="text-[10px] uppercase tracking-wide text-[#82918b]">Terms</div><div className="text-sm font-semibold">Version {deal.termsVersion}</div></div></div>
          {deal.negotiationTurns?.length ? <details className="border-b border-[#e8eeea] px-6 py-3"><summary className="cursor-pointer text-xs font-semibold text-[#526c60]">Negotiation notes ({deal.negotiationTurns.length} turns)</summary><div className="mt-3 space-y-2">{deal.negotiationTurns.map((turn) => <div key={turn.id} className="rounded-xl bg-[#f7f9f6] px-3 py-2 text-xs"><span className="font-bold capitalize text-[#31574a]">{turn.speaker} · {turn.action}</span><p className="mt-1 leading-5 text-[#657572]">{turn.message}</p></div>)}</div></details> : null}
          <div className="divide-y divide-[#edf1ee]">{deal.milestones.map((item) => <article key={item.id} className="grid gap-4 px-6 py-5 sm:grid-cols-[1fr_auto] sm:items-center"><div><div className="flex items-center gap-2 text-sm font-semibold"><span className="grid size-6 place-items-center rounded-lg bg-[#edf4ef] text-[11px] text-[#49715e]">{String(item.idx).padStart(2,"0")}</span>{item.title}</div><p className="ml-8 mt-1.5 text-xs leading-5 text-[#82918b]">{item.description}</p><ul className="ml-8 mt-2 list-disc pl-4 text-xs leading-5 text-[#657572]">{item.acceptanceCriteria?.map((criterion) => <li key={criterion.criterion_id}>{criterion.text}</li>)}</ul><div className="ml-8 mt-3 flex flex-wrap gap-2">{[["Work", item.workStatus], ["Authorization", item.authorizationStatus], ["Capture", item.captureStatus]].map(([label, value]) => <span key={label} className="rounded-full bg-[#f4f6f3] px-2.5 py-1 text-[10px] text-[#657572]">{label}: {value.toLowerCase().replaceAll("_", " ")}</span>)}</div>{item.latestSubmission && <div className="ml-8 mt-4 rounded-xl bg-[#f7f9f6] p-3 text-left"><div className="text-[10px] font-bold uppercase tracking-wide text-[#82918b]">Latest submission</div><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[#526c60]">{item.latestSubmission.evidenceText}</p>{item.latestSubmission.evidenceUrl && <a href={item.latestSubmission.evidenceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-semibold text-[#147d67]">Open submitted link (not fetched by HoldFast) ↗</a>}{item.verification && <div className="mt-3 border-t border-[#e4ebe6] pt-3"><div className="text-xs font-semibold">Advisory: {item.verification.recommendation.toLowerCase()}</div><p className="mt-1 text-xs leading-5 text-[#657572]">{item.verification.summary}</p></div>}</div>}</div><div className="flex flex-col items-start gap-2 sm:items-end"><div className="text-lg font-semibold">{formatMoney(item.amountCents, deal.currency)}</div><div className="text-[11px] text-[#82918b]">{item.payoutStatus === "DISABLED" ? "No payout configured" : item.payoutStatus.toLowerCase()}</div><MilestoneActions milestone={item} role={deal.clientId === user?.id ? "client" : "freelancer"}/></div></article>)}</div>
          <div className="flex items-center justify-between border-t border-[#e8eeea] bg-[#fbfcfa] px-6 py-4 text-xs text-[#657572]"><span className="inline-flex items-center gap-2"><ShieldCheck size={15} className="text-[#147d67]"/>Sandbox only · payout disabled</span><Link href="/" className="font-semibold text-[#147d67]">How HoldFast works <ArrowUpRight className="ml-1 inline" size={13}/></Link></div>
        </section>)}
      </>}
      <div className="mt-8 flex items-center gap-2 text-xs text-[#82918b]"><Clock3 size={14}/>AI evidence review and automatic webhook reconciliation are not enabled yet.</div>
    </div>
  </main>;
}

function Summary({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return <div className="rounded-2xl border border-[#e1e9e3] bg-white p-4"><div className="flex items-center gap-2 text-xs text-[#82918b]">{icon}{label}</div><div className="mt-3 text-2xl font-semibold tracking-tight">{value}</div></div>;
}

function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100);
}

function NegotiationButton({ dealId }: { dealId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/deals/${dealId}/negotiate`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "Negotiation could not start.");
      window.location.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Negotiation could not start."); setBusy(false); }
  }
  return <><button disabled={busy} onClick={() => void start()} className="rounded-full border border-[#cadfd1] bg-[#f1f8f2] px-3 py-1.5 font-bold text-[#31574a] disabled:opacity-60">{busy ? "Negotiating…" : "Negotiate terms"}</button>{error && <span role="alert" className="basis-full text-xs text-[#9a412d]">{error}</span>}</>;
}

async function signTerms(dealId: string, termsVersion: number) {
  const response = await fetch(`/api/v1/deals/${dealId}/sign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terms_version: termsVersion }) });
  if (!response.ok) { const payload = await response.json().catch(() => null); window.alert(payload?.error?.message ?? "Could not sign these terms."); return; }
  window.location.reload();
}

function MilestoneActions({ milestone, role }: { milestone: Milestone; role: "client" | "freelancer" }) {
  const [evidence, setEvidence] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(path: string, body?: unknown, headers: Record<string, string> = {}) {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(path, { method: "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "The action could not be completed.");
      if (payload?.approve_url) { window.location.assign(payload.approve_url); return; }
      if (payload?.verification_error) setMessage(`Submission saved. Review unavailable: ${payload.verification_error}`);
      else if (payload?.verification?.recommendation) setMessage(`Advisory review: ${payload.verification.recommendation.toLowerCase()}. A person makes the release decision.`);
      else if (payload?.capture?.status === "PENDING") setMessage("PayPal is still processing the capture. The authorization is not marked released yet.");
      else setMessage("Action saved.");
      window.setTimeout(() => window.location.reload(), 600);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "A network error occurred."); }
    finally { setBusy(false); }
  }

  const base = `/api/v1/milestones/${milestone.id}`;
  const canSubmit = role === "freelancer" && milestone.authorizationStatus === "AUTHORIZED" && ["NOT_STARTED", "REVISION_REQUESTED"].includes(milestone.workStatus);
  const canFund = role === "client" && milestone.authorizationStatus === "NONE";
  const canCancel = role === "client" && ["NONE", "AUTHORIZED", "UNKNOWN"].includes(milestone.authorizationStatus) && ["NOT_STARTED", "REVISION_REQUESTED"].includes(milestone.workStatus) && milestone.captureStatus === "NONE";
  const canRelease = role === "client" && milestone.authorizationStatus === "AUTHORIZED" && milestone.workStatus === "SUBMITTED" && milestone.captureStatus === "NONE";
  const canRevise = role === "client" && milestone.workStatus === "SUBMITTED" && milestone.captureStatus === "NONE";
  const canVerify = milestone.workStatus === "SUBMITTED";

  return <div className="max-w-full text-left sm:text-right">{canFund && <button disabled={busy} onClick={() => void submit(`${base}/fund`, undefined, { "Idempotency-Key": crypto.randomUUID() }).then(() => undefined)} className="rounded-full bg-[#147d67] px-3.5 py-2 text-xs font-bold text-white disabled:opacity-60">{busy ? "Opening PayPal…" : "Authorize milestone"}</button>}
    {canSubmit && <details className="sm:text-left"><summary className="cursor-pointer rounded-full border border-[#d4e3d9] px-3.5 py-2 text-xs font-bold text-[#31574a]">Submit work</summary><form onSubmit={(event) => { event.preventDefault(); void submit(`${base}/submissions`, { evidence_text: evidence, ...(evidenceUrl ? { evidence_url: evidenceUrl } : {}) }); }} className="mt-2 w-72 max-w-[calc(100vw-3rem)] space-y-2 rounded-2xl border border-[#e1e9e3] bg-white p-3"><textarea required minLength={10} maxLength={20000} value={evidence} onChange={(event) => setEvidence(event.target.value)} rows={3} placeholder="Describe the work and evidence" className="w-full rounded-lg border border-[#dce5df] p-2 text-xs"/><input type="url" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} placeholder="https://evidence-link (optional)" className="w-full rounded-lg border border-[#dce5df] p-2 text-xs"/><button disabled={busy} className="rounded-full bg-[#147d67] px-3 py-2 text-xs font-bold text-white">{busy ? "Saving…" : "Submit for review"}</button></form></details>}
    {canRelease && <button disabled={busy} onClick={() => { if (window.confirm(`Request capture of ${formatMoney(milestone.amountCents, "USD")} to the sandbox merchant? This action cannot be automatically reversed.`)) void submit(`${base}/release`, { confirm_amount_cents: milestone.amountCents }, { "Idempotency-Key": crypto.randomUUID() }); }} className="rounded-full bg-[#173f36] px-3.5 py-2 text-xs font-bold text-white disabled:opacity-60">{busy ? "Requesting capture…" : "Review & release"}</button>}
    {canCancel && <button disabled={busy} onClick={() => { if (window.confirm("Cancel this milestone? Any active PayPal authorization will be voided.")) void submit(`${base}/cancel`); }} className="rounded-full border border-[#e5d6cf] px-3.5 py-2 text-xs font-semibold text-[#885343] disabled:opacity-60">Cancel milestone</button>}
    {canRevise && <button disabled={busy} onClick={() => { const note = window.prompt("What change should the freelancer make?"); if (note) void submit(`${base}/request-revision`, { note }); }} className="rounded-full border border-[#d4e3d9] px-3.5 py-2 text-xs font-semibold text-[#31574a] disabled:opacity-60">Request revision</button>}
    {canVerify && <button disabled={busy} onClick={() => void submit(`${base}/verify`)} className="rounded-full border border-[#d4e3d9] px-3.5 py-2 text-xs font-semibold text-[#31574a] disabled:opacity-60">Run advisory review</button>}
    {message && <p role="status" className="mt-2 max-w-xs text-[11px] text-[#147d67]">{message}</p>}{error && <p role="alert" className="mt-2 max-w-xs text-[11px] text-[#9a412d]">{error}</p>}</div>;
}

function CreateAgreement({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [budget, setBudget] = useState("600");
  const [deadline, setDeadline] = useState("14");
  const [firstAmount, setFirstAmount] = useState("300");
  const [secondAmount, setSecondAmount] = useState("300");
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/deals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, brief, currency: "USD", mandate: { max_total_cents: Math.round(Number(budget) * 100), deadline_days: Number(deadline), priorities: "" }, milestones: [
        { title: "First milestone", description: "Initial deliverable and review.", acceptance_criteria: ["The agreed first deliverable is complete and reviewable."], amount_cents: Math.round(Number(firstAmount) * 100), due_in_days: Math.max(1, Math.floor(Number(deadline) / 2)) },
        { title: "Final delivery", description: "Final delivery, handoff, and completion.", acceptance_criteria: ["The final work is delivered with clear handoff notes."], amount_cents: Math.round(Number(secondAmount) * 100), due_in_days: Number(deadline) },
      ] }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not create this agreement.");
      setInviteUrl(payload.invite_url);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to create agreement."); }
    finally { setBusy(false); }
  }

  return <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[#112a2480] p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby="create-title" className="my-6 w-full max-w-2xl rounded-3xl bg-white p-6 shadow-2xl sm:p-8"><div className="flex items-start justify-between"><div><div className="text-xs font-bold uppercase tracking-[.14em] text-[#147d67]">New collaboration</div><h2 id="create-title" className="mt-2 text-2xl font-semibold tracking-tight">{inviteUrl ? "Invite your freelancer" : "Set the first draft"}</h2><p className="mt-2 text-sm text-[#657572]">{inviteUrl ? "Share this private link. Your freelancer can add their own terms before you both sign." : "Write down the job and an initial milestone outline."}</p></div><button onClick={onClose} aria-label="Close" className="rounded-full border border-[#dce5df] px-3 py-1.5 text-xs text-[#657572]">Close</button></div>
    {inviteUrl ? <div className="mt-6 rounded-2xl bg-[#f1f7f2] p-4"><label className="text-xs font-bold text-[#31574a]">Private invitation link<input readOnly value={inviteUrl} className="mt-2 w-full rounded-lg border border-[#dce5df] bg-white px-3 py-3 text-sm" onFocus={(event) => event.currentTarget.select()}/></label><button onClick={() => void navigator.clipboard.writeText(inviteUrl)} className="mt-3 rounded-full border border-[#c9d9ce] px-4 py-2 text-xs font-semibold text-[#31574a]">Copy invite link</button><button onClick={onCreated} className="ml-2 rounded-full bg-[#147d67] px-4 py-2 text-xs font-bold text-white">Done</button></div> : <form onSubmit={(event) => void create(event)} className="mt-6 space-y-4"><label className="block text-xs font-semibold text-[#526c60]">Agreement title<input required minLength={3} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-2 w-full rounded-xl border border-[#dce5df] px-3 py-3 text-sm font-normal text-[#172c2a]" placeholder="e.g. Bakery landing page"/></label><label className="block text-xs font-semibold text-[#526c60]">Brief<textarea required minLength={20} maxLength={5000} rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} className="mt-2 w-full rounded-xl border border-[#dce5df] px-3 py-3 text-sm font-normal text-[#172c2a]" placeholder="Describe the result you need and what matters."/></label><div className="grid gap-3 sm:grid-cols-2"><Field label="Maximum budget (USD)" value={budget} onChange={setBudget}/><Field label="Target deadline (days)" value={deadline} onChange={setDeadline}/><Field label="First milestone (USD)" value={firstAmount} onChange={setFirstAmount}/><Field label="Final milestone (USD)" value={secondAmount} onChange={setSecondAmount}/></div>{error && <p role="alert" className="rounded-xl bg-[#fff2ed] px-4 py-3 text-sm text-[#9a412d]">{error}</p>}<button disabled={busy} className="rounded-full bg-[#147d67] px-5 py-3 text-sm font-bold text-white disabled:opacity-60">{busy ? "Creating…" : "Create agreement & invitation"}</button></form>}
  </section></div>;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-xs font-semibold text-[#526c60]">{label}<input type="number" min="1" max="100000" step="1" required value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dce5df] px-3 py-3 text-sm font-normal text-[#172c2a]"/></label>;
}
