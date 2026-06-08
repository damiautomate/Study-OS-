"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function Login() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "create">("create");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    setError(""); setMsg("");
    if (!email.trim() || password.length < 6) { setError("Enter an email and a password of at least 6 characters."); return; }
    setBusy(true);
    try {
      const supabase = createClient();
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw new Error(error.message);
        router.push("/");
        return;
      }
      // create account — upgrade the current guest session if there is one (keeps your work)
      const { data: { user } } = await supabase.auth.getUser();
      if (user && user.is_anonymous) {
        const { error } = await supabase.auth.updateUser({ email: email.trim(), password });
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw new Error(error.message);
      }
      setMsg("Account ready. If your project requires email confirmation, check your inbox to finish — otherwise you can sign in anywhere now.");
      setTimeout(() => router.push("/"), 1500);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm px-5 py-16 sm:py-24">
      <Link href="/" className="text-xs text-faint hover:text-muted">← back</Link>
      <p className="mt-8 text-xs uppercase tracking-[0.3em] text-gold-dim mb-3">Study OS</p>
      <h1 className="text-3xl text-paper mb-2">{mode === "create" ? "Create your account" : "Welcome back"}</h1>
      <p className="text-muted mb-8 text-sm leading-relaxed">
        {mode === "create"
          ? "Save your work and reach it from any device. Your current progress carries over."
          : "Sign in to pick up where you left off."}
      </p>

      <div className="space-y-4">
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="Email" className="input" autoComplete="email" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" className="input" autoComplete={mode === "create" ? "new-password" : "current-password"} />
        {error && <p className="text-sm text-rust">{error}</p>}
        {msg && <p className="text-sm text-sage">{msg}</p>}
        <button onClick={submit} disabled={busy} className="w-full rounded-full bg-gold py-3 text-sm font-medium text-ink transition hover:bg-paper disabled:opacity-50">
          {busy ? "…" : mode === "create" ? "Create account" : "Sign in"}
        </button>
      </div>

      <button onClick={() => { setMode(mode === "create" ? "signin" : "create"); setError(""); setMsg(""); }}
        className="mt-6 text-sm text-muted hover:text-paper">
        {mode === "create" ? "Already have an account? Sign in" : "New here? Create an account"}
      </button>

      <style jsx global>{`
        .input { width: 100%; border-radius: 0.75rem; border: 1px solid var(--color-line); background: var(--color-surface); padding: 0.75rem 1rem; color: var(--color-paper); font-size: 0.95rem; outline: none; }
        .input:focus { border-color: var(--color-gold-dim); }
        .input::placeholder { color: var(--color-faint); }
      `}</style>
    </main>
  );
}
