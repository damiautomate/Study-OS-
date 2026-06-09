"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ensureSession } from "@/lib/supabase/client";
import { effectiveDates, todayISO, daysBetween } from "@/lib/semester";
import type { Course } from "@/lib/types";

type Derived = {
  total: number; solid: number; weekTotal: number; weekDone: number;
  daysSince: number | null; nextDate: string | null; deadlineDays: number;
};
type Deadline = { courseId: string; title: string; kind: "EXAM" | "TEST"; date: string };
type Focus = { id: string; courseId: string; courseTitle: string; topicTitle: string; kind: string; done: boolean; urgency: number };
type Cap = { id: string; courseId: string | null; title: string; done: number; total: number };

const fmt = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
function inWords(date: string): string {
  const d = daysBetween(todayISO(), date);
  if (d < 0) return "passed"; if (d === 0) return "today"; if (d < 7) return `in ${d}d`;
  const w = Math.round(d / 7); return `in ${w} wk${w === 1 ? "" : "s"}`;
}

export default function Home() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [derived, setDerived] = useState<Map<string, Derived>>(new Map());
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [focus, setFocus] = useState<Focus[]>([]);
  const [capacity, setCapacity] = useState(10);
  const [caps, setCaps] = useState<Cap[]>([]);
  const [needsIntake, setNeedsIntake] = useState(false);
  const [supa, setSupa] = useState<any>(null);

  useEffect(() => {
    (async () => {
      const supabase = await ensureSession();
      setSupa(supabase);
      const { data: profile } = await supabase.from("student_profile").select("user_id, study_hours_per_day, study_days_per_week").maybeSingle();
      setNeedsIntake(!profile);
      if (profile) setCapacity(Math.round((profile.study_hours_per_day ?? 2) * (profile.study_days_per_week ?? 5)));

      const { data: cs } = await supabase.from("courses").select("*").order("created_at", { ascending: false });
      const list = (cs as Course[]) ?? [];
      setCourses(list);
      const onboarded = list.filter((c) => c.status === "onboarded");
      const ids = onboarded.map((c) => c.id);
      if (ids.length === 0) { setDerived(new Map()); setDeadlines([]); setFocus([]); setCaps([]); return; }

      const sinceISO = new Date(Date.now() - 14 * 86400000).toISOString();
      const [tp, ms, sc, lg, cap] = await Promise.all([
        supabase.from("course_topics").select("id, course_id, level, title").in("course_id", ids).eq("level", 2),
        supabase.from("student_mastery").select("course_id, understanding_state").in("course_id", ids),
        supabase.from("schedule_items").select("id, course_id, topic_id, kind, done").eq("week_index", 1).in("course_id", ids),
        supabase.from("study_log").select("course_id, created_at").gte("created_at", sinceISO).in("course_id", ids),
        supabase.from("capstones").select("id, course_id, title").eq("status", "active").in("course_id", ids),
      ]);
      const titles = new Map((tp.data ?? []).map((t: any) => [t.id, t.title]));
      const courseTitle = new Map(onboarded.map((c) => [c.id, c.title]));

      const tally = (rows: any[], pred: (r: any) => boolean) => {
        const m = new Map<string, number>(); for (const r of rows ?? []) if (pred(r)) m.set(r.course_id, (m.get(r.course_id) ?? 0) + 1); return m;
      };
      const totalT = tally(tp.data ?? [], () => true);
      const solidT = tally(ms.data ?? [], (r) => r.understanding_state === "solid");
      const weekTotalT = tally(sc.data ?? [], () => true);
      const weekDoneT = tally(sc.data ?? [], (r) => r.done);
      const lastT = new Map<string, number>();
      for (const r of lg.data ?? []) lastT.set(r.course_id, Math.max(lastT.get(r.course_id) ?? 0, new Date(r.created_at).getTime()));

      const d = new Map<string, Derived>(); const dls: Deadline[] = []; const today = todayISO();
      for (const c of onboarded) {
        const { examDate, testDate } = effectiveDates(c);
        const upcoming = [examDate, testDate].filter((x): x is string => !!x && x >= today).sort();
        const last = lastT.get(c.id);
        const deadlineDays = upcoming[0] ? daysBetween(today, upcoming[0]) : 9999;
        d.set(c.id, {
          total: totalT.get(c.id) ?? 0, solid: solidT.get(c.id) ?? 0,
          weekTotal: weekTotalT.get(c.id) ?? 0, weekDone: weekDoneT.get(c.id) ?? 0,
          daysSince: last ? Math.floor((Date.now() - last) / 86400000) : null,
          nextDate: upcoming[0] ?? null, deadlineDays,
        });
        if (examDate && examDate >= today) dls.push({ courseId: c.id, title: c.title, kind: "EXAM", date: examDate });
        if (testDate && testDate >= today) dls.push({ courseId: c.id, title: c.title, kind: "TEST", date: testDate });
      }
      dls.sort((a, b) => a.date.localeCompare(b.date));

      // cross-course focus: prioritise by course urgency, learn before revise
      const items: Focus[] = (sc.data ?? []).map((s: any) => ({
        id: s.id, courseId: s.course_id, courseTitle: courseTitle.get(s.course_id) ?? "",
        topicTitle: titles.get(s.topic_id) ?? "—", kind: s.kind, done: s.done,
        urgency: d.get(s.course_id)?.deadlineDays ?? 9999,
      }));
      items.sort((a, b) => Number(a.done) - Number(b.done) || a.urgency - b.urgency || (a.kind === "revise" ? 1 : 0) - (b.kind === "revise" ? 1 : 0));

      // capstone progress
      const capIds = (cap.data ?? []).map((c: any) => c.id);
      let mByCap = new Map<string, { done: number; total: number }>();
      if (capIds.length) {
        const { data: mil } = await supabase.from("capstone_milestones").select("capstone_id, done").in("capstone_id", capIds);
        for (const m of mil ?? []) { const e = mByCap.get(m.capstone_id) ?? { done: 0, total: 0 }; e.total++; if (m.done) e.done++; mByCap.set(m.capstone_id, e); }
      }
      setCaps((cap.data ?? []).map((c: any) => ({ id: c.id, courseId: c.course_id, title: c.title, ...(mByCap.get(c.id) ?? { done: 0, total: 0 }) })));

      setDerived(d); setDeadlines(dls); setFocus(items);
    })();
  }, []);

  async function toggleFocus(f: Focus) {
    if (!supa) return; const done = !f.done;
    setFocus((prev) => prev.map((x) => (x.id === f.id ? { ...x, done } : x)));
    await supa.from("schedule_items").update({ done }).eq("id", f.id);
  }

  const onboarded = (courses ?? []).filter((c) => c.status === "onboarded");
  const onboardedSorted = [...onboarded].sort((a, b) => (derived.get(a.id)?.deadlineDays ?? 9999) - (derived.get(b.id)?.deadlineDays ?? 9999));
  const others = (courses ?? []).filter((c) => c.status !== "onboarded");
  const nearExams = deadlines.filter((d) => d.kind === "EXAM" && daysBetween(todayISO(), d.date) <= 14);
  const focusCap = Math.max(3, Math.floor(capacity / 1.5));
  const notDone = focus.filter((f) => !f.done);
  const focusList = notDone.slice(0, focusCap);
  const remaining = notDone.length - focusList.length;

  return (
    <main className="mx-auto max-w-3xl px-5 py-8 sm:py-12">
      <header className="mb-8 flex items-end justify-between gap-4">
        <h1 className="text-3xl sm:text-4xl leading-[1.05] text-paper">This semester<span className="text-gold">.</span></h1>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Link href="/courses/new" className="rounded-full bg-gold px-4 py-2 text-sm font-medium text-ink transition hover:bg-paper">+ New course</Link>
          <Link href="/courses/new-free" className="text-[11px] text-gold-dim hover:text-gold">+ Free-choice course</Link>
        </div>
      </header>

      {needsIntake && (
        <Link href="/welcome" className="mb-8 block rounded-xl border border-gold/30 bg-gold/5 px-5 py-4 transition hover:border-gold/60">
          <p className="text-sm text-paper">Tell the agent about you →</p>
          <p className="mt-0.5 text-xs text-muted">A one-minute intake so guidance is built around your goals, not generic.</p>
        </Link>
      )}

      {courses === null ? (
        <p className="text-faint text-sm">Loading…</p>
      ) : onboarded.length === 0 && others.length === 0 ? (
        <p className="text-faint text-sm">No courses yet. Add your first one above — upload its slides, notes, and past papers and it gets unpacked, sorted, and mapped. Or start a free-choice course and let it build you a curriculum.</p>
      ) : (
        <>
          {nearExams.length > 0 && (
            <p className="mb-6 rounded-lg border border-rust/30 bg-rust/[0.06] px-4 py-2.5 text-xs text-paper/90">
              {nearExams.length === 1 ? "1 exam" : `${nearExams.length} exams`} within 2 weeks — nearest: <span className="text-rust">{nearExams[0].title}</span> {inWords(nearExams[0].date)}. Protect the closest first.
            </p>
          )}

          {onboarded.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 flex items-center justify-between label text-gold-dim">
                <span>Focus this week</span>
                <span className="text-faint normal-case tracking-normal">~{capacity} hrs/wk · top {focusCap}</span>
              </h2>
              {focus.length === 0 ? (
                <p className="text-xs text-faint">No schedules built yet. Open a course and build its schedule — your week, prioritised across courses, shows up here.</p>
              ) : focusList.length === 0 ? (
                <p className="text-xs text-sage">All caught up for this week. Nice.</p>
              ) : (
                <div className="space-y-1.5">
                  {focusList.map((f, i) => (
                    <div key={f.id} className={`flex items-center gap-2.5 rounded-lg px-4 py-2.5 text-sm ${i === 0 ? "border border-gold/25 bg-gold/[0.05]" : "bg-surface/50"}`}>
                      <input type="checkbox" checked={f.done} onChange={() => toggleFocus(f)} className="accent-gold" />
                      <Link href={`/courses/${f.courseId}`} className="min-w-0 flex-1 truncate text-paper/90 hover:text-paper">
                        <span className={`label mr-1.5 ${f.kind === "revise" ? "text-gold-dim" : "text-sage"}`}>{f.kind}</span>
                        {f.topicTitle}
                      </Link>
                      {i === 0 && <span className="label shrink-0 text-gold">start here</span>}
                      <span className="shrink-0 font-mono text-[11px] text-faint">{f.courseTitle}</span>
                    </div>
                  ))}
                  {remaining > 0 && <p className="pt-0.5 text-[11px] text-faint">+{remaining} more scheduled this week — these come first given your hours and the nearest deadlines.</p>}
                </div>
              )}
            </section>
          )}

          {deadlines.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 label text-gold-dim">Upcoming deadlines</h2>
              <div className="space-y-1.5">
                {deadlines.slice(0, 7).map((d, i) => (
                  <Link key={i} href={`/courses/${d.courseId}`} className="flex items-center justify-between gap-3 text-sm transition hover:text-paper">
                    <span className="truncate text-paper/85">
                      <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] ${d.kind === "EXAM" ? "bg-rust/20 text-rust" : "bg-gold/20 text-gold-dim"}`}>{d.kind}</span>
                      {d.title}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">{inWords(d.date)} · {fmt(d.date)}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {caps.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 label text-gold-dim">Capstones</h2>
              <div className="space-y-1.5">
                {caps.map((c) => (
                  <Link key={c.id} href={`/courses/${c.courseId}`} className="flex items-center justify-between gap-3 rounded-lg bg-surface/40 px-4 py-2.5 text-sm transition hover:bg-surface">
                    <span className="truncate text-paper/90">{c.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">{c.total ? `${c.done}/${c.total} milestones` : "not planned yet"}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-3 label text-gold-dim">Courses</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {onboardedSorted.map((c) => {
                const v = derived.get(c.id);
                const pct = v && v.total > 0 ? Math.round((v.solid / v.total) * 100) : 0;
                const quiet = v?.daysSince != null && v.daysSince >= 4;
                return (
                  <Link key={c.id} href={`/courses/${c.id}`} className="rise block rounded-xl border border-line bg-surface px-5 py-4 transition hover:border-gold-dim">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-base text-paper">{c.title}</h3>
                        <p className="mt-0.5 text-xs text-faint">{c.free_choice ? "Free choice" : c.code || ""}</p>
                      </div>
                      {quiet && <span className="shrink-0 rounded-full bg-gold/15 px-2 py-0.5 text-[10px] text-gold-dim">quiet</span>}
                    </div>
                    {v && v.total > 0 && (
                      <div className="mb-2">
                        <div className="h-1 overflow-hidden rounded-full bg-line"><div className="h-full bg-sage" style={{ width: `${pct}%` }} /></div>
                        <p className="mt-1 font-mono text-[11px] text-faint">{v.solid}/{v.total} topics solid</p>
                      </div>
                    )}
                    <p className="text-[11px] text-muted">{v?.nextDate ? `${c.free_choice ? "Target" : "Next deadline"} ${inWords(v.nextDate)} · ${fmt(v.nextDate)}` : "No date set"}</p>
                  </Link>
                );
              })}
              {others.map((c) => (
                <Link key={c.id} href={`/courses/${c.id}`} className="rise block rounded-xl border border-line bg-surface px-5 py-4 transition hover:border-gold-dim">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-base text-paper">{c.title}</h3>
                      <p className="mt-0.5 text-xs text-faint">{c.free_choice ? "Free choice" : c.code || ""}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-gold/15 px-2.5 py-1 label text-gold">{c.status === "onboarding" ? "building" : c.status}</span>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
