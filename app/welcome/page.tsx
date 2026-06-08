"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ensureSession } from "@/lib/supabase/client";

const STRUGGLES = [
  "I lose consistency mid-semester",
  "I cram right before exams",
  "I read but don't really understand",
  "I don't know what to study",
  "Questions feel too hard to even start",
];
const STYLES = [
  { key: "gentle", label: "Gentle nudges" },
  { key: "firm", label: "Firm push" },
  { key: "stakes", label: "Stakes / penalties" },
  { key: "structure", label: "Just structure, no pressure" },
];

export default function Welcome() {
  const router = useRouter();
  const [hours, setHours] = useState("");
  const [goal, setGoal] = useState("");
  const [motivation, setMotivation] = useState("");
  const [struggles, setStruggles] = useState<string[]>([]);
  const [style, setStyle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggle(s: string) {
    setStruggles((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  async function save() {
    setError("");
    if (!goal.trim()) { setError("A one-line goal for the semester helps the agent the most."); return; }
    setBusy(true);
    try {
      const supabase = await ensureSession();
      const { error: e } = await supabase.from("student_profile").upsert(
        {
          study_hours_per_day: hours ? Number(hours) : null,
          semester_goal: goal.trim(),
          motivation: motivation.trim() || null,
          past_struggles: struggles,
          accountability_style: style || null,
        },
        { onConflict: "user_id" },
      );
      if (e) throw new Error(e.message);
      router.push("/");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl px-5 py-12 sm:py-16">
      <p className="text-xs uppercase tracking-[0.3em] text-gold-dim mb-3">Study OS</p>
      <h1 className="text-3xl sm:text-4xl text-paper mb-2">First, a little about you</h1>
      <p className="text-muted mb-10 leading-relaxed">
        This is how the agent learns to guide <em>you</em> — what you're aiming for, what's tripped
        you up before, and how you like to be pushed. Takes a minute.
      </p>

      <div className="space-y-6">
        <Field label="A goal for this semester">
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2}
            placeholder="e.g. Actually understand my courses, not just pass" className="input" />
        </Field>

        <Field label="What would you love to be able to build or do?">
          <textarea value={motivation} onChange={(e) => setMotivation(e.target.value)} rows={2}
            placeholder="The thing that would make the work feel worth it" className="input" />
        </Field>

        <Field label="What's gone wrong before? (pick any)">
          <div className="flex flex-wrap gap-2">
            {STRUGGLES.map((s) => (
              <button key={s} onClick={() => toggle(s)} type="button"
                className={`rounded-full border px-3 py-1.5 text-xs transition ${
                  struggles.includes(s) ? "border-gold bg-gold/10 text-gold" : "border-line text-muted hover:border-gold-dim"
                }`}>
                {s}
              </button>
            ))}
          </div>
        </Field>

        <Field label="How do you want to be held accountable?">
          <div className="flex flex-wrap gap-2">
            {STYLES.map((s) => (
              <button key={s.key} onClick={() => setStyle(s.key)} type="button"
                className={`rounded-full border px-3 py-1.5 text-xs transition ${
                  style === s.key ? "border-gold bg-gold/10 text-gold" : "border-line text-muted hover:border-gold-dim"
                }`}>
                {s.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Realistic study hours per day">
          <input type="number" min="0" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)}
            placeholder="e.g. 2" className="input" />
        </Field>

        {error && <p className="text-sm text-rust">{error}</p>}

        <button onClick={save} disabled={busy}
          className="w-full rounded-full bg-gold py-3 text-sm font-medium text-ink transition hover:bg-paper disabled:opacity-50">
          {busy ? "Saving…" : "Save & continue"}
        </button>
      </div>

      <style jsx global>{`
        .input {
          width: 100%; border-radius: 0.75rem; border: 1px solid var(--color-line);
          background: var(--color-surface); padding: 0.75rem 1rem; color: var(--color-paper);
          font-size: 0.95rem; outline: none; font-family: inherit; resize: vertical;
        }
        .input:focus { border-color: var(--color-gold-dim); }
        .input::placeholder { color: var(--color-faint); }
      `}</style>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-muted">{label}</label>
      {children}
    </div>
  );
}
