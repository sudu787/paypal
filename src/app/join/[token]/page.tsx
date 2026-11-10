"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Handshake, LoaderCircle } from "lucide-react";

type Invite = { id: string; title: string; brief: string; status: string; clientName: string };

export default function JoinInvite() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [minimum, setMinimum] = useState("450");
  const [days, setDays] = useState("10");
  const [preferred, setPreferred] = useState("2");
  const [priorities, setPriorities] = useState("");
  const [paypalEmail, setPaypalEmail] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([fetch(`/api/v1/deals?invite=${encodeURIComponent(token)}`).then((r) => r.json()), fetch("/api/v1/me").then((r) => r.ok)])
      .then(([payload, authenticated]) => { if (!active) return; if (payload.error) throw new Error(payload.error.message); setInvite(payload.invite); setSignedIn(authenticated); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "This invitation could not be loaded."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [token]);

  async function join(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/deals/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite_token: token, mandate: { min_total_cents: Math.round(Number(minimum) * 100), earliest_days: Number(days), preferred_milestones: Number(preferred), priorities }, ...(paypalEmail ? { paypal_email: paypalEmail } : {}) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not join this agreement.");
      setDone(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to join this agreement."); }
    finally { setBusy(false); }
  }

  const returnTo = `/join/${encodeURIComponent(token)}`;
  return <main className="hero-glow grain min-h-screen px-5 py-6"><header className="mx-auto flex max-w-6xl items-center justify-between"><Link href="/" className="flex items-center gap-3 font-bold"><span className="grid size-10 place-items-center rounded-2xl bg-[#173f36] text-white"><Handshake size={21}/></span>holdfast<span className="-ml-3 text-[#17836b]">.</span></Link><Link href="/" className="text-sm text-[#657572]"><ArrowLeft className="mr-1 inline" size={15}/>Home</Link></header>
    <section className="mx-auto max-w-2xl py-14"><div className="rounded-[2rem] border border-white bg-white/90 p-6 shadow-[0_30px_90px_#234a381d] sm:p-9">{busy && !invite ? <div className="flex items-center gap-2 text-sm text-[#657572]"><LoaderCircle className="animate-spin" size={16}/>Loading invitation…</div> : error && !invite ? <div role="alert" className="text-sm text-[#9a412d]">{error}</div> : invite && <>
      <div className="text-xs font-bold uppercase tracking-[.15em] text-[#147d67]">Freelancer invitation</div><h1 className="mt-3 text-3xl font-semibold tracking-tight text-[#173f36]">{done ? "You're part of the agreement." : invite.title}</h1><p className="mt-3 text-sm leading-6 text-[#657572]">{done ? "Your private minimum terms are saved. Review the proposed milestones with the client before signing." : `${invite.clientName} invited you to join this service agreement.`}</p><div className="mt-6 rounded-2xl bg-[#f5f8f5] p-4"><div className="text-xs font-bold uppercase tracking-wide text-[#82918b]">Project brief</div><p className="mt-2 text-sm leading-6 text-[#31574a]">{invite.brief}</p></div>
      {done ? <button onClick={() => router.push("/workspace")} className="mt-6 rounded-full bg-[#147d67] px-5 py-3 text-sm font-bold text-white">Go to workspace <ArrowRight className="ml-2 inline" size={15}/></button> : !signedIn ? <div className="mt-6 rounded-2xl border border-[#dce8df] p-4 text-sm text-[#526c60]">Sign in or create an account to save your private terms and join. <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="ml-1 font-bold text-[#147d67]">Continue to sign in <ArrowRight className="inline" size={14}/></Link></div> : <form onSubmit={(event) => void join(event)} className="mt-6 space-y-4"><div className="text-sm font-semibold">Your private terms <span className="font-normal text-[#82918b]">(only you can see these)</span></div><div className="grid gap-4 sm:grid-cols-3"><label className="text-xs font-semibold text-[#526c60]">Minimum total (USD)<input type="number" min="1" step="1" value={minimum} onChange={(e) => setMinimum(e.target.value)} required className="mt-2 w-full rounded-xl border border-[#dce5df] px-3 py-3 text-sm text-[#172c2a]"/></label><label className="text-xs font-semibold text-[#526c60]">Earliest delivery (days)<input type="number" min="1" max="365" value={days} onChange={(e) => setDays(e.target.value)} required className="mt-2 w-full rounded-xl border border-[#dce5df] px-3 py-3 text-sm text-[#172c2a]"/></label><label className="text-xs font-semibold text-[#526c60]">Preferred milestones<input type="number" min="1" max="12" value={preferred} onChange={(e) => setPreferred(e.target.value)} required className="mt-2 w-full rounded-xl border border-[#dce5df] px-3 py-3 text-sm text-[#172c2a]"/></label></div><label className="block text-xs font-semibold text-[#526c60]">PayPal email <span className="font-normal">(optional for this prototype)</span><input type="email" value={paypalEmail} onChange={(e) => setPaypalEmail(e.target.value)} className="mt-2 w-full rounded-xl border border-[#dce5df] px-3 py-3 text-sm text-[#172c2a]" placeholder="you@example.com"/></label><label className="block text-xs font-semibold text-[#526c60]">What matters to you?<textarea value={priorities} onChange={(e) => setPriorities(e.target.value)} rows={3} maxLength={1000} className="mt-2 w-full resize-y rounded-xl border border-[#dce5df] px-3 py-3 text-sm font-normal text-[#172c2a]" placeholder="Scope clarity, feedback time, accessibility…"/></label>{error && <p role="alert" className="rounded-xl bg-[#fff2ed] px-4 py-3 text-sm text-[#9a412d]">{error}</p>}<button disabled={busy} className="rounded-full bg-[#147d67] px-5 py-3 text-sm font-bold text-white disabled:opacity-60">{busy ? "Joining…" : "Join agreement"}<ArrowRight className="ml-2 inline" size={15}/></button><p className="text-xs leading-5 text-[#82918b]">Joining does not sign the agreement. Both people must review and sign the same terms version before work starts.</p></form>}
      </>}</div></section></main>;
}
