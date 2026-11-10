"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleDollarSign, Handshake, LoaderCircle } from "lucide-react";

type LedgerRow = { event: { id: string; createdAt: string; category: string; eventType: string; actorType: string; amountCents: number | null; currency: string | null; paypalRef: string | null; note: string | null }; dealTitle: string | null; milestoneTitle: string | null; actorName: string | null };

export default function LedgerPage() {
  const router = useRouter();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    void fetch("/api/v1/ledger").then(async (response) => {
      const payload = await response.json();
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not load the ledger.");
      if (alive) setRows(payload.rows ?? []);
    }).catch((caught) => { if (alive) setError(caught instanceof Error ? caught.message : "Could not load the ledger."); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [router]);

  return <main className="min-h-screen bg-[#f7f8f5]"><header className="border-b border-[#e2e9e4] bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8"><Link href="/workspace" className="flex items-center gap-3 font-bold"><span className="grid size-9 place-items-center rounded-xl bg-[#173f36] text-white"><Handshake size={19}/></span>holdfast<span className="-ml-3 text-[#17836b]">.</span></Link><Link href="/workspace" className="text-sm font-medium text-[#526c60]"><ArrowLeft className="mr-1 inline" size={15}/>Workspace</Link></div></header><section className="mx-auto max-w-7xl px-5 py-10 lg:px-8"><div className="text-xs font-bold uppercase tracking-[.15em] text-[#147d67]">Audit trail</div><h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#173f36]">Ledger</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#657572]">Application-recorded agreement, work, and PayPal events. A pending or unknown outcome is not a completed payment.</p>
    {loading ? <div className="mt-8 flex items-center gap-2 text-sm text-[#657572]"><LoaderCircle size={16} className="animate-spin"/>Loading events…</div> : error ? <p role="alert" className="mt-8 rounded-2xl bg-[#fff2ed] p-4 text-sm text-[#9a412d]">{error}</p> : rows.length === 0 ? <div className="mt-8 rounded-2xl border border-dashed border-[#cad8ce] bg-white p-8 text-sm text-[#657572]">No events have been recorded yet.</div> : <div className="mt-8 overflow-x-auto rounded-2xl border border-[#e1e9e3] bg-white"><table className="w-full min-w-[760px] border-collapse text-left text-sm"><thead className="bg-[#f5f8f5] text-xs uppercase tracking-wide text-[#82918b]"><tr><th className="px-4 py-3">Time</th><th className="px-4 py-3">Event</th><th className="px-4 py-3">Agreement / milestone</th><th className="px-4 py-3">Actor</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Reference</th></tr></thead><tbody className="divide-y divide-[#edf1ee]">{rows.map(({ event, dealTitle, milestoneTitle, actorName }) => <tr key={event.id} className="align-top"><td className="whitespace-nowrap px-4 py-3 text-xs text-[#657572]">{new Date(event.createdAt).toLocaleString()}</td><td className="px-4 py-3"><div className="font-semibold text-[#31574a]">{event.eventType.toLowerCase().replaceAll("_", " ")}</div><div className="mt-1 text-[10px] uppercase tracking-wide text-[#82918b]">{event.category}</div></td><td className="px-4 py-3"><div className="font-medium">{dealTitle ?? "Account"}</div>{milestoneTitle && <div className="mt-1 text-xs text-[#82918b]">{milestoneTitle}</div>}</td><td className="px-4 py-3 text-xs text-[#657572]">{actorName ?? event.actorType.toLowerCase()}</td><td className="whitespace-nowrap px-4 py-3 text-right font-medium">{event.amountCents === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: event.currency ?? "USD" }).format(event.amountCents / 100)}</td><td className="max-w-[180px] truncate px-4 py-3 font-mono text-[10px] text-[#82918b]" title={event.paypalRef ?? undefined}>{event.paypalRef ?? event.note ?? "—"}</td></tr>)}</tbody></table></div>}
    <div className="mt-5 flex items-center gap-2 text-xs text-[#82918b]"><CircleDollarSign size={14}/>Application audit by convention; PayPal remains the source of truth for provider status.</div></section></main>;
}
