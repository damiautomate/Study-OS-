"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ensureSession } from "@/lib/supabase/client";
import { effectiveDates, todayISO, daysBetween } from "@/lib/semester";
import type { Course } from "@/lib/types";

type Focus = { id: string; courseId: string; courseTitle: string; topicTitle: string; kind: string; done: boolean; urgency: number };
type Deadline = { courseId: string; title: string; kind: "EXAM" | "TEST"; date: string };

const fmt = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
function inWords(date: string): string {
  const d = daysBetween(todayISO(), date);
  if (d <= 0) return d === 0 ? "today" : "passed";
  if (d < 7) return `in ${d}d`;
  const w = Math.round(d / 7); return `in ${w} wk${w === 1 ? "" : "s"}`;
}
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late night session";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function Today() {
  const [supa, setSupa] = useState<any>(null);
  const [name, setName] = useState<string>("");
  const [focus, setFocus] = useState<Focus[] | null>(null);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [streak, setStreak] = useState(0);
  const [studiedToday, setStudiedToday] = useState(false);
  const [hasCourses, setHasCourses] = useState<boolean | null>(null);
  const [needsIntake, setNeedsIntake] = useState(false);
  const [justDone, setJustDone] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = await ensureSession();
      setSupa(supabase);
      const { data: profile } = await supabase.from("student_profile").select("user_id, semester_goal").maybeSingle();
      setNeedsIntake(!profile);

      const { data: cs } = await supabase.from("courses").select("*");
      const list = (cs as Course[]) ?? [];
      setHasCourses(list.length > 0);
      const onboarded = list.filter((c) => c.status === "onboarded");
      const ids = onboarded.map((c) => c.id);
      const courseTitle = new Map(onboarded.map((c) => [c.id, c.title]));

      // streak from study_log (any course)
      const since = new Date(Date.now() - 90 * 86400000).toISOString();
      const { data: lg } = await supabase.from("study_log").select("created_at, course_id").gte("created_at", since);
      const days = new Set((lg ?? []).map((l: any) => dayKey(new Date(l.created_at).getTime())));
      const today = dayKey(Date.now());
      setStudiedToday(days.has(today));
      let s = 0; let cursor = days.has(today) ? Date.now() : Date.now() - 86400000;
      while (days.has(dayKey(cursor))) { s++; cursor -= 86400000; }
      setStreak(s);

      if (ids.length === 0) { setFocus([]); setDeadlines([]); return; }

      const today2 = todayISO();
      const dls: Deadline[] = []; const urg = new Map<string, number>();
      for (const c of onboarded) {
        const { examDate, testDate } = effectiveDates(c);
        const next = [examDate, testDate].filter((x): x is string => !!x && x >= today2).sort()[0];
        urg.set(c.id, next ? daysBetween(today2, next) : 9999);
        if (examDate && examDate >= today2) dls.push({ courseId: c.id, title: c.title, kind: "EXAM", date: examDate });
        if (testDate && testDate >= today2) dls.push({ courseId: c.id, title: c.title, kind: "TEST", date: testDate });
      }
      dls.sort((a, b) => a.date.localeCompare(b.date));
      setDeadlines(dls.slice(0, 3));

      const [sc, tp] = await Promise.all([
        supabase.from("schedule_items").select("id, course_id, topic_id, kind, done").eq("week_index", 1).in("course_id", ids),
        supabase.from("course_topics").select("id, title").in("course_id", ids),
      ]);
      const titles = new Map((tp.data ?? []).map((t: any) => [t.id, t.title]));
      const items: Focus[] = (sc.data ?? []).map((s2: any) => ({
        id: s2.id, courseId: s2.course_id, courseTitle: courseTitle.get(s2.course_id) ?? "",
        topicTitle: titles.get(s2.topic_id) ?? "—", kind: s2.kind, done: s2.done,
        urgency: urg.get(s2.course_id) ?? 9999,
      }));
      items.sort((a, b) => Number(a.done) - Number(b.done) || a.urgency - b.urgency || (a.kind === "revise" ? 1 : 0) - (b.kind === "revise" ? 1 : 0));
      setFocus(items);
    })();
  }, []);

  async function toggle(f: Focus) {
    if (!supa) return;
    const done = !f.done;
    setFocus((prev) => (prev ?? []).map((x) => (x.id === f.id ? { ...x, done } : x)));
    if (done) { setJustDone(f.id); setStudiedToday(true); setTimeout(() => setJustDone(null), 500); }
    await supa.from("schedule_items").update({ done }).eq("id", f.id);
  }

  const notDone = (focus ?? []).filter((f) => !f.done);
  const upNext = notDone.slice(0, 3);
  const doneToday = (focus ?? []).filter((f) => f.done).length;

  return (
    <main className="mx-auto max-w-xl px-5 pb-10 pt-7 sm:pt-10">
      <header className="mb-6">
        <p className="label text-gold">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</p>
        <h1 className="mt-1 font-display text-[28px] font-semibold leading-tight text-paper sm:text-3xl">
          {greeting()}{name ? `, ${name}` : ""} —<br className="sm:hidden" /> here&apos;s today.
        </h1>
      </header>

      {/* streak + today state */}
      <div className="card mb-6 flex items-center justify-between rounded-2xl px-5 py-4">
        <div className="flex items-center gap-3">
          <span className={`text-2xl ${studiedToday ? "pop" : ""}`}>🔥</span>
          <div>
            <p className="font-display text-lg font-semibold leading-none text-paper">
              {streak} day{streak === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-xs text-muted">
              {studiedToday ? "You've shown up today. Streak safe." : streak > 0 ? "Do one small thing to keep it alive." : "Start a streak today — one topic is enough."}
            </p>
          </div>
        </div>
        <span className={`h-2.5 w-2.5 rounded-full ${studiedToday ? "bg-sage" : "bg-gold pulse-dot"}`} />
      </div>

      {needsIntake && (
        <Link href="/welcome" className="card mb-6 block rounded-2xl border-gold/40 px-5 py-4 transition hover:border-gold">
          <p className="text-sm font-medium text-paper">Tell your coach about you →</p>
          <p className="mt-0.5 text-xs text-muted">One minute. It makes everything personal.</p>
        </Link>
      )}

      {/* up next */}
      <section className="mb-7">
        <div className="mb-2.5 flex items-baseline justify-between">
          <h2 className="label text-faint">Up next</h2>
          {doneToday > 0 && <span className="font-mono text-[11px] text-sage">{doneToday} done ✓</span>}
        </div>
        {focus === null ? (
          <div className="card h-24 animate-pulse rounded-2xl" />
        ) : hasCourses === false ? (
          <Link href="/courses" className="card block rounded-2xl px-5 py-5 text-sm text-muted transition hover:border-gold/50">
            No courses yet. <span className="text-gold">Add your first →</span>
          </Link>
        ) : (focus.length === 0 ? (
          <Link href="/courses" className="card block rounded-2xl px-5 py-5 text-sm text-muted transition hover:border-gold/50">
            No week planned yet. Open a course and <span className="text-gold">build its schedule →</span>
          </Link>
        ) : upNext.length === 0 ? (
          <div className="card rounded-2xl px-5 py-5 text-sm text-sage">All clear for this week. Rest is part of the plan. ✓</div>
        ) : (
          <div className="space-y-2">
            {upNext.map((f, i) => (
              <div key={f.id}
                className={`card flex items-center gap-3 rounded-2xl px-4 py-3.5 transition ${i === 0 ? "border-gold/50" : ""} ${justDone === f.id ? "pop" : ""}`}>
                <button onClick={() => toggle(f)}
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 transition ${f.done ? "border-sage bg-sage text-ink" : "border-line hover:border-gold"}`}>
                  {f.done && <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="m5 13 4 4L19 7" /></svg>}
                </button>
                <Link href={`/courses/${f.courseId}`} className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-paper">{f.topicTitle}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    <span className={`label mr-1.5 ${f.kind === "revise" ? "text-gold-dim" : "text-sage"}`}>{f.kind}</span>
                    {f.courseTitle}
                  </p>
                </Link>
                {i === 0 && <span className="label shrink-0 text-gold">start</span>}
              </div>
            ))}
            {notDone.length > 3 && (
              <p className="px-1 pt-0.5 text-[11px] text-faint">+{notDone.length - 3} more this week — these three first.</p>
            )}
          </div>
        ))}
      </section>

      {/* deadlines */}
      {deadlines.length > 0 && (
        <section className="mb-7">
          <h2 className="label mb-2.5 text-faint">Coming up</h2>
          <div className="card divide-y divide-line rounded-2xl">
            {deadlines.map((d, i) => (
              <Link key={i} href={`/courses/${d.courseId}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition hover:bg-raised/50">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`label shrink-0 rounded-md px-1.5 py-0.5 ${d.kind === "EXAM" ? "bg-rust/10 text-rust" : "bg-gold/10 text-gold-dim"}`}>{d.kind}</span>
                  <span className="truncate text-paper">{d.title}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-faint">{inWords(d.date)} · {fmt(d.date)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <Link href="/courses" className="block text-center text-sm text-muted transition hover:text-paper">
        All courses →
      </Link>
    </main>
  );
}
