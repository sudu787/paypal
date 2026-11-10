"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleDollarSign, Handshake, LoaderCircle } from "lucide-react";
import type { LedgerRow } from "./ledger-grid";

const LedgerGrid = dynamic(() => import("./ledger-grid"), {
  ssr: false,
  loading: () => <div className="mt-8 flex items-center gap-2 text-sm text-[#657572]"><LoaderCircle size={16} className="animate-spin"/>Loading ledger controls…</div>,
});

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
    }).catch((caught) => {
      if (alive) setError(caught instanceof Error ? caught.message : "Could not load the ledger.");
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [router]);

  return <main className="min-h-screen bg-[#f7f8f5]">
    <header className="border-b border-[#e2e9e4] bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8"><Link href="/workspace" className="flex items-center gap-3 font-bold"><span className="grid size-9 place-items-center rounded-xl bg-[#173f36] text-white"><Handshake size={19}/></span>holdfast<span className="-ml-3 text-[#17836b]">.</span></Link><Link href="/workspace" className="text-sm font-medium text-[#526c60]"><ArrowLeft className="mr-1 inline" size={15}/>Workspace</Link></div></header>
    <section className="mx-auto max-w-7xl px-5 py-10 lg:px-8">
      <div className="text-xs font-bold uppercase tracking-[.15em] text-[#147d67]">Audit trail</div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#173f36]">Ledger</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-[#657572]">Application-recorded agreement, work, and PayPal events. A pending or unknown outcome is not a completed payment.</p>
      {loading ? <div className="mt-8 flex items-center gap-2 text-sm text-[#657572]"><LoaderCircle size={16} className="animate-spin"/>Loading events…</div>
        : error ? <p role="alert" className="mt-8 rounded-2xl bg-[#fff2ed] p-4 text-sm text-[#9a412d]">{error}</p>
          : <LedgerGrid rows={rows}/>}
      <div className="mt-5 flex items-center gap-2 text-xs text-[#82918b]"><CircleDollarSign size={14}/>Application audit history; PayPal remains the source of truth for provider status.</div>
    </section>
  </main>;
}
