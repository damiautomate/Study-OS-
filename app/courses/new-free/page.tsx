"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ensureSession } from "@/lib/supabase/client";
import { todayISO } from "@/lib/semester";

export default function NewFreeCourse() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState("");
  const [target, setTarget] = useState("");
  const [phase, setPhase] = useState<"form" | "building">("form");
  const [error, setError] = useState("");

  async function create() {
    setError("");
    if (!title.trim() || !topic.trim()) { setError("Give it a name and say what you want to learn."); return; }
    setPhase("building");
    try {
      const supabase = await ensureSession();
      const { data: course, error: e1 } = await supabase.from("courses").insert({
        title: title.trim(),
        semester_start: todayISO(),
        status: "onboarding",
        free_choice: true,
        target_date: target || null,
        target_goal: goal.trim() || null,
      }).select("id").single();
      if (e1 || !course) throw new Error(e1?.message ?? "could not create");

      await fetch("/api/coach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "curriculum", courseId: course.id, topic: topic.trim(), goal: goal.trim() }),
      });

      // poll until the curriculum is built (status flips to onboarded)
      const id = course.id;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const { data: c } = await supabase.from("courses").select("status").eq("id", id).maybeSingle();
        if (c?.status === "onboarded") { router.push(`/courses/${id}`); return; }
      }
      router.push(`/courses/${id}`); // give up waiting; the page will catch up
    } catch (e) {
      setError((e as Error).message);
      setPhase("form");
    }
  }

  if (phase === "building") {
    return (
      <main className="mx-auto max-w-md px-5 py-24 text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-gold-dim mb-4">Study OS</p>
        <h1 className="text-2xl text-paper mb-3">Building your curriculum…</h1>
        <p className="text-sm text-muted">Designing modules and topics for “{topic}”. This takes a few seconds — you'll land on the course when it's ready.</p>
        <div className="mt-8 h-1 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full w-1/3 animate-pulse bg-gold" />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-5 py-16 sm:py-20">
      <Link href="/" className="text-xs text-faint hover:text-muted">← back</Link>
      <p className="mt-8 text-xs uppercase tracking-[0.3em] text-gold-dim mb-3">Free-choice course</p>
      <h1 className="text-3xl text-paper mb-2">Learn something for you.</h1>
      <p className="text-muted mb-8 text-sm leading-relaxed">
        A self-chosen course on anything — fuel to keep momentum. No exam calendar; you set the pace.
        Upload nothing: the system builds you a curriculum to follow.
      </p>

      <div className="space-y-4">
        <label className="block">
          <span className="text-xs text-faint">Course name</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Practical Machine Learning" className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-paper outline-none focus:border-gold-dim" />
        </label>
        <label className="block">
          <span className="text-xs text-faint">What do you want to learn?</span>
          <textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={2} placeholder="e.g. Build and train neural networks from scratch, understand transformers" className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-paper outline-none focus:border-gold-dim" />
        </label>
        <label className="block">
          <span className="text-xs text-faint">Your goal (optional)</span>
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Ship a small ML project I can show" className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-paper outline-none focus:border-gold-dim" />
        </label>
        <label className="block">
          <span className="text-xs text-faint">Target date (optional)</span>
          <input type="date" value={target} onChange={(e) => setTarget(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-paper outline-none focus:border-gold-dim" />
        </label>
        {error && <p className="text-sm text-rust">{error}</p>}
        <button onClick={create} className="w-full rounded-full bg-gold py-3 text-sm font-medium text-ink transition hover:bg-gold-dim">
          Build my curriculum
        </button>
      </div>
    </main>
  );
}
