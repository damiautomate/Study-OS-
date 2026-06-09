"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ensureSession } from "@/lib/supabase/client";
import { effectiveDates, todayISO, daysBetween } from "@/lib/semester";
import type { Course } from "@/lib/types";

type Derived = { total: number; solid: number; nextDate: string | null; deadlineDays: number; quiet: boolean };

const fmt = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
function inWords(date: string): string {
  const d = daysBetween(todayISO(), date);
  if (d <= 0) return d === 0 ? "today" : "passed";
  if (d < 7) return `in ${d}d`;
  const w = Math.round(d / 7); return `in ${w} wk${w === 1 ? "" : "s"}`;
}

export default function Courses() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [derived, setDerived] = useState<Map<string, Derived>>(new Map());

  useEffect(() => {
    (async () => {
      const supabase = await ensureSession();
      const { data: cs } = await supabase.from("courses").select("*").order("created_at", { ascending: false });
      const list = (cs as Course[]) ?? [];
      setCourses(list);
      const onboarded = list.filter((c) => c.status === "onboarded");
      const ids = onboarded.map((c) => c.id);
      if (ids.length === 0) return;

      const sinceISO = new Date(Date.now() - 14 * 86400000).toISOString();
      const [tp, ms, lg] = await Promise.all([
        supabase.from("course_topics").select("course_id, level").in("course_id", ids).eq("level", 2),
        supabase.from("student_mastery").select("course_id, understanding_state").in("course_id", ids),
        supabase.from("study_log").select("course_id, created_at").gte("created_at", sinceISO).in("course_id", ids),
      ]);
      const tally = (rows: any[], pred: (r: any) => boolean) => {
        const m = new Map<string, number>(); for (const r of rows ?? []) if (pred(r)) m.set(r.course_id, (m.get(r.course_id) ?? 0) + 1); return m;
      };
      const totalT = tally(tp.data ?? [], () => true);
      const solidT = tally(ms.data ?? [], (r) => r.understanding_state === "solid");
      const lastT = new Map<string, number>();
      for (const r of lg.data ?? []) lastT.set(r.course_id, Math.max(lastT.get(r.course_id) ?? 0, new Date(r.created_at).getTime()));

      const today = todayISO();
      const d = new Map<string, Derived>();
      for (const c of onboarded) {
        const { examDate, testDate } = effectiveDates(c);
        const next = [examDate, testDate].filter((x): x is string => !!x && x >= today).sort()[0] ?? null;
        const last = lastT.get(c.id);
        d.set(c.id, {
          total: totalT.get(c.id) ?? 0, solid: solidT.get(c.id) ?? 0,
          nextDate: next, deadlineDays: next ? daysBetween(today, next) : 9999,
          quiet: last ? (Date.now() - last) / 86400000 >= 4 : true,
        });
      }
      setDerived(d);
    })();
  }, []);

  const onboarded = (courses ?? []).filter((c) => c.status === "onboarded")
    .sort((a, b) => (derived.get(a.id)?.deadlineDays ?? 9999) - (derived.get(b.id)?.deadlineDays ?? 9999));
  const building = (courses ?? []).filter((c) => c.status !== "onboarded");

  return (
    <main className="mx-auto max-w-3xl px-5 pb-10 pt-7 sm:pt-10">
      <header className="mb-6 flex items-end justify-between gap-4">
        <h1 className="font-display text-[28px] font-semibold leading-tight text-paper sm:text-3xl">Courses</h1>
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/courses/new-free" className="rounded-full border border-line bg-surface px-3.5 py-2 text-xs font-medium text-muted transition hover:border-gold hover:text-paper">
            Free-choice
          </Link>
          <Link href="/courses/new" className="rounded-full bg-gold px-4 py-2 text-sm font-semibold text-ink shadow-sm transition hover:bg-gold-dim">
            + Add
          </Link>
        </div>
      </header>

      {courses === null ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="card h-28 animate-pulse rounded-2xl" />)}
        </div>
      ) : courses.length === 0 ? (
        <div className="card rounded-2xl px-6 py-10 text-center">
          <p className="font-display text-lg font-semibold text-paper">Bring your semester in.</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Upload a course&apos;s slides, notes, and past papers — it gets unpacked, mapped, and turned into a plan.</p>
          <Link href="/courses/new" className="mt-5 inline-block rounded-full bg-gold px-5 py-2.5 text-sm font-semibold text-ink shadow-sm transition hover:bg-gold-dim">Add your first course</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {onboarded.map((c) => {
            const v = derived.get(c.id);
            const pct = v && v.total > 0 ? Math.round((v.solid / v.total) * 100) : 0;
            return (
              <Link key={c.id} href={`/courses/${c.id}`} className="card rise block rounded-2xl px-5 py-4 transition hover:-translate-y-0.5 hover:border-gold/50">
                <div className="mb-2.5 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-display text-[17px] font-semibold text-paper">{c.title}</h3>
                    <p className="mt-0.5 font-mono text-[11px] text-faint">{c.free_choice ? "free choice" : c.code || "—"}</p>
                  </div>
                  {v?.quiet && <span className="label shrink-0 rounded-md bg-gold/10 px-1.5 py-0.5 text-gold-dim">quiet</span>}
                </div>
                {v && v.total > 0 && (
                  <div className="mb-2">
                    <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                      <div className="h-full rounded-full bg-sage transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="mt-1.5 font-mono text-[11px] text-faint">{v.solid}/{v.total} solid</p>
                  </div>
                )}
                <p className="font-mono text-[11px] text-muted">
                  {v?.nextDate ? `${c.free_choice ? "target" : "exam"} ${inWords(v.nextDate)} · ${fmt(v.nextDate)}` : "no date set"}
                </p>
              </Link>
            );
          })}
          {building.map((c) => (
            <Link key={c.id} href={`/courses/${c.id}`} className="card rise block rounded-2xl border-dashed px-5 py-4 transition hover:border-gold/50">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-display text-[17px] font-semibold text-paper">{c.title}</h3>
                  <p className="mt-0.5 font-mono text-[11px] text-faint">{c.free_choice ? "free choice" : c.code || "—"}</p>
                </div>
                <span className="label shrink-0 rounded-md bg-gold/10 px-2 py-1 text-gold-dim">
                  {c.status === "review" ? "review" : "building"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
