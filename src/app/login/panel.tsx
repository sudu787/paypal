"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, ArrowRight, Handshake, LoaderCircle, ShieldCheck } from "lucide-react";

type Persona = "client" | "freelancer" | "admin";

export function AuthPanel({ demoEnabled, adminDemoEnabled, startInDemo }: { demoEnabled: boolean; adminDemoEnabled: boolean; startInDemo: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function callApi(path: string, body: unknown) {
    setBusy(true); setError("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not sign in. Try again.");
      const returnTo = new URLSearchParams(window.location.search).get("returnTo");
      router.push(returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/workspace"); router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "A network error occurred.");
    } finally { setBusy(false); }
  }

  return <main className="hero-glow grain flex min-h-screen flex-col px-5 py-6">
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between"><Link href="/" className="flex items-center gap-3 font-bold"><span className="grid size-10 place-items-center rounded-2xl bg-[#173f36] text-white"><Handshake size={21}/></span><span>holdfast<span className="text-[#17836b]">.</span></span></Link><Link href="/" className="text-sm font-medium text-[#657572] hover:text-[#172c2a]"><ArrowLeft className="mr-1 inline" size={15}/> Back to home</Link></header>
    <section className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-12 py-12 md:grid-cols-[1fr_.9fr]">
      <div className="hidden md:block"><div className="text-xs font-bold uppercase tracking-[.16em] text-[#147d67]">Your work, with more clarity</div><h1 className="mt-5 max-w-lg text-5xl font-semibold leading-tight tracking-[-.05em] text-[#173f36]">Build trust into the work from day one.</h1><p className="mt-5 max-w-md leading-7 text-[#657572]">Review milestones, see payment authorization status, and keep important decisions visible to both sides.</p><div className="mt-9 flex items-center gap-3 rounded-2xl border border-[#e2eae4] bg-white/70 p-4 text-sm text-[#42645a]"><ShieldCheck className="shrink-0 text-[#17836b]" size={20}/>Payments use PayPal sandbox. Authorization does not guarantee capture or settlement.</div></div>
      <div className="rounded-[2rem] border border-white bg-white/90 p-6 shadow-[0_30px_90px_#234a381d] sm:p-9"><div className="flex rounded-xl bg-[#f2f6f2] p-1"><button onClick={() => setMode("login")} className={`flex-1 rounded-lg py-2.5 text-sm font-semibold ${mode === "login" ? "bg-white text-[#173f36] shadow-sm" : "text-[#657572]"}`}>Sign in</button><button onClick={() => setMode("register")} className={`flex-1 rounded-lg py-2.5 text-sm font-semibold ${mode === "register" ? "bg-white text-[#173f36] shadow-sm" : "text-[#657572]"}`}>Create account</button></div>
        <h2 className="mt-7 text-2xl font-semibold tracking-tight">{mode === "login" ? "Welcome back" : "Start with a clear agreement"}</h2><p className="mt-2 text-sm leading-6 text-[#657572]">{mode === "login" ? "Sign in to continue to your workspace." : "Create an account to get started with HoldFast."}</p>
        <form className="mt-6 space-y-4" onSubmit={(event) => { event.preventDefault(); void callApi(`/api/v1/auth/${mode}`, { email, password, ...(mode === "register" ? { displayName } : {}) }); }}>
          {mode === "register" && <label className="block text-sm font-semibold">Name<input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required minLength={2} maxLength={80} className="mt-2 block w-full rounded-xl border border-[#dce5df] bg-white px-4 py-3 font-normal outline-none focus:border-[#50a68c]" placeholder="Your name"/></label>}
          <label className="block text-sm font-semibold">Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required className="mt-2 block w-full rounded-xl border border-[#dce5df] bg-white px-4 py-3 font-normal outline-none focus:border-[#50a68c]" placeholder="you@example.com"/></label>
          <label className="block text-sm font-semibold">Password<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === "register" ? 12 : 1} maxLength={128} className="mt-2 block w-full rounded-xl border border-[#dce5df] bg-white px-4 py-3 font-normal outline-none focus:border-[#50a68c]" placeholder={mode === "register" ? "At least 12 characters" : "Your password"}/></label>
          {error && <p role="alert" className="rounded-xl bg-[#fff2ed] px-4 py-3 text-sm text-[#9a412d]">{error}</p>}
          <button disabled={busy} className="w-full rounded-full bg-[#147d67] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#106c5a] disabled:opacity-60">{busy ? <><LoaderCircle className="mr-2 inline animate-spin" size={16}/>Working…</> : <>{mode === "login" ? "Sign in" : "Create account"}<ArrowRight className="ml-2 inline" size={16}/></>}</button>
        </form>
        {demoEnabled && <>
          <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-[#9aa7a1]"><span className="h-px flex-1 bg-[#e7ede9]"/>or use the demo<span className="h-px flex-1 bg-[#e7ede9]"/></div>
          {startInDemo && <p className="mb-3 rounded-xl bg-[#f2f7f2] px-3 py-2 text-xs leading-5 text-[#526c60]">Demo workspaces are isolated per browser. You can switch personas here without signing out to keep the same sample agreement. {adminDemoEnabled && "Use the admin persona to inspect the local job queue."}</p>}
          <div className="grid grid-cols-2 gap-3">{((adminDemoEnabled ? ["client", "freelancer", "admin"] : ["client", "freelancer"]) as Persona[]).map((persona) => <button key={persona} disabled={busy} onClick={() => void callApi("/api/v1/auth/demo", { persona })} className="rounded-xl border border-[#dce5df] px-3 py-3 text-sm font-semibold text-[#31574a] hover:bg-[#f5f9f5] disabled:opacity-60">{busy ? "Please wait…" : `Demo ${persona}`}</button>)}</div>
        </>}
      </div>
    </section><footer className="mx-auto w-full max-w-6xl py-3 text-center text-xs text-[#82918b]">HoldFast is a hackathon prototype. PayPal sandbox only.</footer>
  </main>;
}
