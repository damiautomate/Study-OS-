"use client";

import { useEffect, useRef, useState } from "react";
import { ensureSession } from "@/lib/supabase/client";
import type { ScheduleItem } from "@/lib/types";

type Summary = {
  totalWeeks: number; learningWeeks: number; bufferWeeks: number;
  deadline: string | null; testDate: string | null;
  topics: number; learnTopics: number;
  capacityPerWeek: number; neededPerWeek: number; overCapacity: boolean;
};

const fmt = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const within = (d: string | null, start: string, end: string) => !!d && d >= start && d <= end;

export default function SchedulePanel({ courseId }: { courseId: string }) {
  const supaRef = useRef<Awaited<ReturnType<typeof ensureSession>> | null>(null);
  const [uid, setUid] = useState<string | null>(null);
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [examDate, setExamDate] = useState("");
  const [testDate, setTestDate] = useState("");
  const [weight, setWeight] = useState(3);
  const [hoursPerDay, setHoursPerDay] = useState(2);
  const [daysPerWeek, setDaysPerWeek] = useState(5);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);

  async function loadItems(supabase: any) {
    const { data } = await supabase.from("schedule_items").select("*").eq("course_id", courseId).order("week_index").order("order_index");
    setItems((data as ScheduleItem[]) ?? []);
  }

  useEffect(() => {
    let channel: any = null;
    (async () => {
      const supabase = await ensureSession();
      supaRef.current = supabase;
      const { data: authData } = await supabase.auth.getUser();
      setUid(authData.user?.id ?? null);

      const { data: c } = await supabase.from("courses").select("test_date, exam_date, weight").eq("id", courseId).maybeSingle();
      if (c) { setExamDate(c.exam_date ?? ""); setTestDate(c.test_date ?? ""); setWeight(c.weight ?? 3); }
      const { data: p } = await supabase.from("student_profile").select("study_hours_per_day, study_days_per_week").maybeSingle();
      if (p) { setHoursPerDay(p.study_hours_per_day ?? 2); setDaysPerWeek(p.study_days_per_week ?? 5); }

      const { data: tp } = await supabase.from("course_topics").select("id, title").eq("course_id", courseId);
      setTitles(new Map((tp ?? []).map((t: any) => [t.id, t.title])));

      await loadItems(supabase);
      channel = supabase.channel(`sched-${courseId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "schedule_items", filter: `course_id=eq.${courseId}` },
          () => loadItems(supabase))
        .subscribe();
    })();
    return () => { if (channel) channel.unsubscribe(); };
  }, [courseId]);

  async function saveSettings() {
    const supabase = supaRef.current!;
    setSaved(false);
    await supabase.from("courses").update({ exam_date: examDate || null, test_date: testDate || null, weight }).eq("id", courseId);
    if (uid) await supabase.from("student_profile").update({ study_hours_per_day: hoursPerDay, study_days_per_week: daysPerWeek }).eq("user_id", uid);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function generate() {
    setBusy(true);
    try {
      await saveSettings();
      const res = await fetch("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId }) });
      const json = await res.json();
      if (json.ok) setSummary(json as Summary);
    } catch { /* */ }
    setBusy(false);
  }

  async function toggle(it: ScheduleItem) {
    const supabase = supaRef.current!;
    const done = !it.done;
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, done } : x)));
    await supabase.from("schedule_items").update({ done }).eq("id", it.id);
  }

  // group by week
  const byWeek = new Map<number, ScheduleItem[]>();
  for (const it of items) { const a = byWeek.get(it.week_index) ?? []; a.push(it); byWeek.set(it.week_index, a); }
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);

  return (
    <section className="mb-10 rounded-xl border border-line bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="label text-gold-dim">Semester schedule</h2>
        <div className="flex gap-2">
          <button onClick={() => setSettingsOpen((v) => !v)} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted transition hover:text-paper">
            Dates &amp; capacity
          </button>
          <button onClick={generate} disabled={busy} className="rounded-full border border-gold/40 px-3 py-1.5 text-xs text-gold transition hover:bg-gold/10 disabled:opacity-50">
            {busy ? "Planning…" : items.length ? "Re-plan" : "Build schedule"}
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="mb-5 grid grid-cols-2 gap-3 rounded-lg bg-raised/70 p-4 text-xs sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-faint">Exam date
            <input type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} className="rounded-md border border-line bg-surface px-2 py-1.5 text-paper" />
          </label>
          <label className="flex flex-col gap-1 text-faint">Test date
            <input type="date" value={testDate} onChange={(e) => setTestDate(e.target.value)} className="rounded-md border border-line bg-surface px-2 py-1.5 text-paper" />
          </label>
          <label className="flex flex-col gap-1 text-faint">Importance (1–5)
            <input type="number" min={1} max={5} value={weight} onChange={(e) => setWeight(Math.max(1, Math.min(5, +e.target.value || 3)))} className="rounded-md border border-line bg-surface px-2 py-1.5 text-paper" />
          </label>
          <label className="flex flex-col gap-1 text-faint">Study hrs/day
            <input type="number" min={0.5} step={0.5} value={hoursPerDay} onChange={(e) => setHoursPerDay(+e.target.value || 2)} className="rounded-md border border-line bg-surface px-2 py-1.5 text-paper" />
          </label>
          <label className="flex flex-col gap-1 text-faint">Study days/week
            <input type="number" min={1} max={7} value={daysPerWeek} onChange={(e) => setDaysPerWeek(Math.max(1, Math.min(7, +e.target.value || 5)))} className="rounded-md border border-line bg-surface px-2 py-1.5 text-paper" />
          </label>
          <div className="col-span-2 flex items-end sm:col-span-3">
            <button onClick={saveSettings} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:text-paper">Save</button>
            {saved && <span className="ml-2 self-center text-xs text-sage">Saved</span>}
            <span className="ml-auto self-center text-[11px] text-faint">Exam dates shift — set yours and re-plan; the schedule re-balances around it.</span>
          </div>
        </div>
      )}

      {summary && (
        <p className={`mb-4 text-[11px] ${summary.overCapacity ? "text-rust" : "text-faint"}`}>
          {summary.totalWeeks} weeks to exam · {summary.learningWeeks} learning + {summary.bufferWeeks} revision ·
          ~{summary.neededPerWeek} hrs/week needed vs ~{summary.capacityPerWeek} hrs/week you have
          {summary.overCapacity ? " — over capacity; consider more hours/days, or it'll protect tested topics first." : ""}
        </p>
      )}

      {weeks.length === 0 ? (
        <p className="text-sm text-muted">No schedule yet. Set your dates, then build it — it spreads topics across the weeks before your exam and reserves the last week or two for revision.</p>
      ) : (
        <div className="space-y-3">
          {weeks.map((w) => {
            const wi = byWeek.get(w)!;
            const ws = wi[0].week_start, we = wi[0].week_end;
            const isNow = w === 1;
            const examHere = within((summary?.deadline ?? examDate) || null, ws, we);
            const testHere = within((summary?.testDate ?? testDate) || null, ws, we);
            const doneN = wi.filter((x) => x.done).length;
            return (
              <div key={w} className={`rounded-lg px-4 py-3 ${isNow ? "border border-gold/30 bg-gold/[0.04]" : "bg-raised/50"}`}>
                <div className="mb-1.5 flex items-center justify-between text-[11px]">
                  <span className={isNow ? "text-gold" : "text-muted"}>
                    {isNow ? "This week" : `Week ${w}`} · {fmt(ws)}–{fmt(we)}
                    {examHere && <span className="ml-2 rounded bg-rust/20 px-1.5 py-0.5 text-rust">EXAM</span>}
                    {testHere && <span className="ml-2 rounded bg-gold/20 px-1.5 py-0.5 text-gold-dim">TEST</span>}
                  </span>
                  <span className="text-faint">{doneN}/{wi.length} done</span>
                </div>
                <ul className="space-y-1">
                  {wi.map((it) => (
                    <li key={it.id} className="flex items-start gap-2 text-xs">
                      <input type="checkbox" checked={it.done} onChange={() => toggle(it)} className="mt-0.5 accent-gold" />
                      <span className={it.done ? "text-faint line-through" : "text-paper/85"}>
                        <span className={`mr-1.5 text-[10px] uppercase ${it.kind === "revise" ? "text-gold-dim" : "text-sage"}`}>{it.kind}</span>
                        {titles.get(it.topic_id ?? "") ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
