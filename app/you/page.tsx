"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ensureSession } from "@/lib/supabase/client";

export default function You() {
  const [supa, setSupa] = useState<any>(null);
  const [uid, setUid] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [motivation, setMotivation] = useState("");
  const [hours, setHours] = useState(2);
  const [days, setDays] = useState(5);
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);
  const [stats, setStats] = useState<{ days30: number; topicsSolid: number }>({ days30: 0, topicsSolid: 0 });

  useEffect(() => {
    (async () => {
      const supabase = await ensureSession();
      setSupa(supabase);
      const { data: { user } } = await supabase.auth.getUser();
      setUid(user?.id ?? null);
      setEmail(user?.email ?? null);

      const { data: p } = await supabase.from("student_profile")
        .select("semester_goal, motivation, study_hours_per_day, study_days_per_week").maybeSingle();
      setHasProfile(!!p);
      if (p) {
        setGoal(p.semester_goal ?? ""); setMotivation(p.motivation ?? "");
        setHours(p.study_hours_per_day ?? 2); setDays(p.study_days_per_week ?? 5);
      }

      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const [{ data: lg }, { data: ms }] = await Promise.all([
        supabase.from("study_log").select("created_at").gte("created_at", since),
        supabase.from("student_mastery").select("understanding_state"),
      ]);
      const dset = new Set((lg ?? []).map((l: any) => new Date(l.created_at).toISOString().slice(0, 10)));
      setStats({ days30: dset.size, topicsSolid: (ms ?? []).filter((m: any) => m.understanding_state === "solid").length });
    })();
  }, []);

  async function save() {
    if (!supa || !uid) return;
    setSaved(false);
    await supa.from("student_profile").update({
      semester_goal: goal.trim() || null,
      motivation: motivation.trim() || null,
      study_hours_per_day: hours,
      study_days_per_week: days,
    }).eq("user_id", uid);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <main className="mx-auto max-w-xl px-5 pb-10 pt-7 sm:pt-10">
      <h1 className="mb-6 font-display text-[28px] font-semibold leading-tight text-paper sm:text-3xl">You</h1>

      {/* monthly snapshot */}
      <div className="mb-6 grid grid-cols-2 gap-3">
        <div className="card rounded-2xl px-5 py-4">
          <p className="font-display text-2xl font-semibold text-paper">{stats.days30}<span className="text-base text-faint">/30</span></p>
          <p className="mt-0.5 text-xs text-muted">days studied this month</p>
        </div>
        <div className="card rounded-2xl px-5 py-4">
          <p className="font-display text-2xl font-semibold text-sage">{stats.topicsSolid}</p>
          <p className="mt-0.5 text-xs text-muted">topics mastered</p>
        </div>
      </div>

      {hasProfile === false ? (
        <Link href="/welcome" className="card mb-6 block rounded-2xl border-gold/40 px-5 py-4 transition hover:border-gold">
          <p className="text-sm font-medium text-paper">Set up your profile →</p>
          <p className="mt-0.5 text-xs text-muted">One minute — it personalises everything.</p>
        </Link>
      ) : (
        <div className="card mb-6 space-y-4 rounded-2xl px-5 py-5">
          <h2 className="label text-faint">Your semester</h2>
          <label className="block">
            <span className="text-xs text-muted">Goal</span>
            <input value={goal} onChange={(e) => setGoal(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-gold" />
          </label>
          <label className="block">
            <span className="text-xs text-muted">What you want to be able to do</span>
            <input value={motivation} onChange={(e) => setMotivation(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-gold" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-muted">Study hrs/day</span>
              <input type="number" min={0.5} step={0.5} value={hours} onChange={(e) => setHours(+e.target.value || 2)} className="mt-1 w-full rounded-xl border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-gold" />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Days/week</span>
              <input type="number" min={1} max={7} value={days} onChange={(e) => setDays(Math.max(1, Math.min(7, +e.target.value || 5)))} className="mt-1 w-full rounded-xl border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-gold" />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={save} className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-ink shadow-sm transition hover:bg-gold-dim">Save</button>
            {saved && <span className="text-xs text-sage">Saved ✓</span>}
          </div>
        </div>
      )}

      <div className="card rounded-2xl px-5 py-5">
        <h2 className="label mb-3 text-faint">Account</h2>
        {email ? (
          <p className="text-sm text-muted">Signed in as <span className="text-paper">{email}</span>.</p>
        ) : (
          <p className="text-sm text-muted">
            You&apos;re on a guest session. <Link href="/login" className="text-gold hover:text-gold-dim">Create an account</Link> to keep your work safe and use it on any device.
          </p>
        )}
      </div>
    </main>
  );
}
