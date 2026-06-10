"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ensureSession } from "@/lib/supabase/client";
import AgentPanel from "./AgentPanel";
import SchedulePanel from "./SchedulePanel";
import CapstonePanel from "./CapstonePanel";
import AddMaterials from "./AddMaterials";
import type { Course, OnboardingRun, RunEvent, SourceFile, CourseTopic, Question } from "@/lib/types";
import { effectiveDates, todayISO, daysBetween } from "@/lib/semester";

const STATUS_LABEL: Record<string, string> = {
  read: "Read",
  needs_ocr: "Reading scans",
  partial: "Partly read",
  ocr_failed: "OCR failed",
  unsupported: "Unsupported",
  failed: "Unreadable",
  duplicate: "Duplicates",
  pending: "Waiting",
};
const STATUS_TONE: Record<string, string> = {
  read: "text-sage",
  needs_ocr: "text-gold",
  partial: "text-gold",
  ocr_failed: "text-rust",
  unsupported: "text-faint",
  failed: "text-rust",
  duplicate: "text-faint",
  pending: "text-muted",
};
const EVENT_TONE: Record<string, string> = {
  success: "text-sage",
  warning: "text-gold",
  error: "text-rust",
  stage: "text-paper",
  info: "text-muted",
};
const CATEGORY_LABEL: Record<string, string> = {
  slides: "Lecture slides",
  textbook: "Textbook",
  notes: "Notes",
  assignment: "Assignment",
  test: "Test",
  exam: "Exam",
  solutions: "Solutions",
  outline: "Course outline",
  other: "Other",
};

export default function OnboardingView({ courseId }: { courseId: string }) {
  const [course, setCourse] = useState<Course | null>(null);
  const [run, setRun] = useState<OnboardingRun | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [topics, setTopics] = useState<CourseTopic[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [tracking, setTracking] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<"plan" | "coach" | "capstone" | "materials">("plan");
  const feedEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = null;

    (async () => {
      const supabase = await ensureSession();

      const { data: c } = await supabase.from("courses").select("*").eq("id", courseId).single();
      setCourse((c as Course) ?? null);

      const { data: r } = await supabase
        .from("onboarding_runs")
        .select("*")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const runRow = (r as OnboardingRun) ?? null;
      setRun(runRow);
      setLoaded(true);
      if (!runRow) return;

      const { data: ev } = await supabase
        .from("run_events").select("*").eq("run_id", runRow.id).order("ts", { ascending: true });
      setEvents((ev as RunEvent[]) ?? []);

      const { data: fl } = await supabase
        .from("source_files").select("*").eq("run_id", runRow.id).order("created_at", { ascending: true });
      setFiles((fl as SourceFile[]) ?? []);

      const { data: tp } = await supabase
        .from("course_topics").select("*").eq("course_id", courseId).order("order_index", { ascending: true });
      setTopics((tp as CourseTopic[]) ?? []);

      const { data: qs } = await supabase
        .from("questions").select("*").eq("course_id", courseId);
      setQuestions((qs as Question[]) ?? []);

      const { count: mcount } = await supabase
        .from("student_mastery").select("id", { count: "exact", head: true }).eq("course_id", courseId);
      setTracking(mcount ?? 0);

      channel = supabase
        .channel(`run-${runRow.id}`)
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "run_events", filter: `run_id=eq.${runRow.id}` },
          (p) => setEvents((prev) => [...prev, p.new as RunEvent]))
        .on("postgres_changes",
          { event: "*", schema: "public", table: "source_files", filter: `run_id=eq.${runRow.id}` },
          (p) => {
            const row = p.new as SourceFile;
            setFiles((prev) => {
              const i = prev.findIndex((f) => f.id === row.id);
              if (i === -1) return [...prev, row];
              const next = [...prev]; next[i] = row; return next;
            });
          })
        .on("postgres_changes",
          { event: "UPDATE", schema: "public", table: "onboarding_runs", filter: `id=eq.${runRow.id}` },
          (p) => setRun(p.new as OnboardingRun))
        .on("postgres_changes",
          { event: "*", schema: "public", table: "course_topics", filter: `course_id=eq.${courseId}` },
          (p) => {
            const row = p.new as CourseTopic;
            if (!row?.id) return;
            setTopics((prev) => {
              const i = prev.findIndex((t) => t.id === row.id);
              if (i === -1) return [...prev, row];
              const next = [...prev]; next[i] = row; return next;
            });
          })
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "questions", filter: `course_id=eq.${courseId}` },
          (p) => setQuestions((prev) => [...prev, p.new as Question]))
        .subscribe();
    })();

    return () => { if (channel) channel.unsubscribe(); };
  }, [courseId]);

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [events]);

  const real = files.filter((f) => f.read_status !== "duplicate");
  const inFlight = new Set(["pending", "needs_ocr"]);
  const processed = real.filter((f) => !inFlight.has(f.read_status)).length;
  const total = real.length;
  const pct = total ? Math.round((processed / total) * 100) : 0;
  const isDone = run?.status === "done";
  const isFailed = run?.status === "failed";

  const groups: Record<string, SourceFile[]> = {};
  for (const f of files) (groups[f.read_status] ??= []).push(f);
  const order = ["read", "partial", "needs_ocr", "ocr_failed", "unsupported", "failed", "duplicate", "pending"];

  const qByType = questions.reduce<Record<string, number>>((a, q) => { const k = q.q_type || "other"; a[k] = (a[k] || 0) + 1; return a; }, {});
  const topicsWithQ = new Set(questions.map((q) => q.topic_id).filter(Boolean)).size;
  const withSolution = questions.filter((q) => q.has_solution).length;

  const l2 = topics.filter((t) => t.level === 2);
  const topicsNoReading = l2.filter((t) => t.source_count === 0);
  const topicsNoQuestions = l2.filter((t) => t.question_count === 0);
  const unreadableCount = files.filter((f) => ["failed", "ocr_failed", "unsupported"].includes(f.read_status)).length;
  const untaggedCount = questions.filter((q) => !q.topic_id).length;

  async function confirmOnboarding() {
    const supabase = await ensureSession();
    await supabase.from("courses").update({ status: "onboarded" }).eq("id", courseId);
    setCourse((c) => (c ? { ...c, status: "onboarded" } : c));
    // seed per-topic mastery so the agent can track progress from here
    const leaf = topics.filter((t) => t.level === 2);
    if (leaf.length > 0) {
      const rows = leaf.map((t) => ({ course_id: courseId, topic_id: t.id }));
      await supabase.from("student_mastery").upsert(rows, { onConflict: "user_id,topic_id", ignoreDuplicates: true });
      setTracking(leaf.length);
    }
  }

  if (loaded && !run && course?.status !== "onboarded") {
    return (
      <main className="mx-auto max-w-3xl px-5 py-16">
        <p className="text-muted">No onboarding run found for this course.</p>
      </main>
    );
  }

  const onboarded = course?.status === "onboarded";
  const { examDate } = course ? effectiveDates(course) : { examDate: null };
  const wk = examDate && examDate >= todayISO() ? Math.max(0, Math.round(daysBetween(todayISO(), examDate) / 7)) : null;
  const deadlineChip = wk != null ? `${course?.free_choice ? "target" : "exam"} ~${wk} wk${wk === 1 ? "" : "s"}` : null;

  const courseMap = topics.length > 0 ? (
    <section>
      <h2 className="label text-gold-dim mb-4">Course map</h2>
      <ol className="space-y-5">
        {topics.filter((t) => t.level === 1).map((mod) => (
          <li key={mod.id} className="rise">
            <h3 className="text-lg text-paper">{mod.title}</h3>
            <ul className="mt-2 space-y-1.5 border-l border-line pl-4">
              {topics.filter((t) => t.parent_id === mod.id).map((sub) => (
                <li key={sub.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-paper/85">{sub.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-faint">{sub.source_file_ids && sub.source_file_ids.length > 0 ? `${sub.source_file_ids.length} src` : "—"}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  ) : null;

  const questionBank = questions.length > 0 ? (
    <section>
      <h2 className="label text-gold-dim mb-4">Question bank</h2>
      <div className="rounded-xl border border-line bg-surface p-5">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-3xl text-gold">{questions.length}</span>
          <span className="text-sm text-muted">question{questions.length === 1 ? "" : "s"} · {topicsWithQ} topic{topicsWithQ === 1 ? "" : "s"} covered · {withSolution} with solutions</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(qByType).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
            <span key={t} className="rounded bg-raised px-2 py-0.5 font-mono text-[11px] text-paper/80">{t} · {n}</span>
          ))}
        </div>
      </div>
    </section>
  ) : null;

  const coverage = (isDone || onboarded) && l2.length > 0 ? (
    <section>
      <h2 className="label text-gold-dim mb-4">Coverage &amp; gaps</h2>
      <div className="space-y-3">
        <GapRow tone={topicsNoReading.length ? "warn" : "ok"} label="Topics with no reading material" count={topicsNoReading.length} items={topicsNoReading.map((t) => t.title)} />
        <GapRow tone={topicsNoQuestions.length ? "warn" : "ok"} label="Topics with no practice questions" count={topicsNoQuestions.length} items={topicsNoQuestions.map((t) => t.title)} />
        <GapRow tone={untaggedCount ? "info" : "ok"} label="Questions not matched to a topic" count={untaggedCount} />
        <GapRow tone={unreadableCount ? "info" : "ok"} label="Files that couldn't be read" count={unreadableCount} />
      </div>
    </section>
  ) : null;

  const inventory = files.length > 0 ? (
    <section>
      <h2 className="label text-gold-dim mb-4">Inventory</h2>
      <div className="space-y-6">
        {order.filter((k) => groups[k]?.length).map((k) => (
          <div key={k}>
            <div className="mb-2 flex items-center gap-2">
              <span className={`text-sm font-medium ${STATUS_TONE[k]}`}>{STATUS_LABEL[k]}</span>
              <span className="font-mono text-xs text-faint">({groups[k].length})</span>
            </div>
            <ul className="space-y-2">
              {groups[k].map((f) => (
                <li key={f.id} className="rounded-lg border border-line/60 bg-raised/40 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm text-paper/90">{f.original_path.split("/").pop()}</span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">{f.page_count ? `${f.page_count}p` : ""}{f.note && (k !== "read" || f.note.startsWith("using:")) ? ` · ${f.note}` : ""}</span>
                  </div>
                  {f.category && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="label rounded bg-gold/10 px-1.5 py-0.5 text-gold-dim">{CATEGORY_LABEL[f.category] ?? f.category}</span>
                      {f.contains_questions && <span className="text-[10px] text-sage">has questions</span>}
                      {typeof f.category_confidence === "number" && f.category_confidence > 0 && f.category_confidence < 0.6 && <span className="text-[10px] text-gold">check this</span>}
                    </div>
                  )}
                  {f.summary && <p className="mt-1 text-xs leading-snug text-muted">{f.summary}</p>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  ) : null;

  const activity = (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center gap-2">
        {!isDone && !isFailed && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-gold" />}
        <h2 className="label text-gold-dim">Activity</h2>
      </div>
      {events.length === 0 && !isDone && !isFailed && (
        <p className="mb-2 text-xs text-muted">Waiting for the worker… if nothing appears here within a minute, the onboarding-worker Edge Function likely isn&apos;t deployed correctly — check its Logs in Supabase.</p>
      )}
      <ol className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {events.map((e) => (
          <li key={e.id} className="rise text-sm leading-relaxed">
            <span className="mr-2 font-mono text-[11px] text-faint">{new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className={EVENT_TONE[e.kind] ?? "text-muted"}>{e.message}</span>
          </li>
        ))}
        <div ref={feedEnd} />
      </ol>
    </section>
  );

  const progress = (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="label text-faint">{isFailed ? "Stopped" : isDone ? "Inventory ready" : "Onboarding"}</span>
        <span className="font-mono text-[11px] text-faint">{total ? `${processed} / ${total}` : ""}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
        <div className={`h-full rounded-full transition-all duration-500 ${isFailed ? "bg-rust" : isDone ? "bg-sage" : "bg-gold"}`} style={{ width: `${isDone ? 100 : pct}%` }} />
      </div>
    </div>
  );

  const TABS = [["plan", "This week"], ["coach", "Coach"], ["capstone", "Capstone"], ["materials", "Library"]] as const;

  return (
    <main className="mx-auto max-w-3xl px-5 pb-24 pt-6 sm:pt-8">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-3xl leading-tight text-paper sm:text-4xl">{course?.title ?? "Course"}</h1>
            <p className="mt-1 text-xs text-faint">{course?.free_choice ? "Free-choice course" : course?.code || ""}</p>
          </div>
          <span className={`label shrink-0 rounded-full px-2.5 py-1 ${onboarded ? "bg-sage/15 text-sage" : course?.status === "review" ? "bg-gold/15 text-gold" : "bg-raised text-muted"}`}>
            {onboarded ? "onboarded" : course?.status === "review" ? "review" : isFailed ? "stopped" : "building"}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 font-mono text-[11px]">
          {l2.length > 0 && <span className="rounded bg-raised px-2 py-1 text-muted">{l2.length} topics</span>}
          {questions.length > 0 && <span className="rounded bg-raised px-2 py-1 text-muted">{questions.length} questions</span>}
          {deadlineChip && <span className="rounded bg-raised px-2 py-1 text-muted">{deadlineChip}</span>}
        </div>
      </header>

      {onboarded ? (
        <>
          <nav className="sticky top-12 z-30 -mx-5 mb-7 overflow-x-auto border-b border-line/70 bg-ink/90 px-5 py-2 backdrop-blur-md">
            <div className="flex w-max gap-1.5">
              {TABS.map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)}
                  className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition ${tab === k ? "bg-paper font-medium text-ink shadow-sm" : "bg-surface text-muted border border-line hover:text-paper"}`}>
                  {label}
                </button>
              ))}
            </div>
          </nav>

          {tab === "plan" && (<div className="rise"><SchedulePanel courseId={courseId} /></div>)}
          {tab === "coach" && (<div className="rise"><AgentPanel courseId={courseId} /></div>)}
          {tab === "capstone" && (<div className="rise"><CapstonePanel courseId={courseId} /></div>)}
          {tab === "materials" && (<div className="space-y-10 rise"><AddMaterials courseId={courseId} onMerged={() => window.location.reload()} />{coverage}{courseMap}{questionBank}{inventory}</div>)}
        </>
      ) : (
        <div className="space-y-10">
          {isDone && course?.status === "review" && (
            <div className="rounded-xl border border-gold/30 bg-gold/5 p-5 rise">
              <p className="text-sm text-paper">Onboarding complete. Check the map, question bank, and gaps — then confirm.</p>
              <button onClick={confirmOnboarding} className="mt-3 rounded-full bg-gold px-5 py-2 text-sm font-medium text-ink transition hover:bg-gold-dim">Looks right — finish onboarding</button>
            </div>
          )}
          {progress}
          {activity}
          {courseMap}
          {questionBank}
          {coverage}
          {inventory}
        </div>
      )}
    </main>
  );
}

function GapRow({ label, count, items, tone }: { label: string; count: number; items?: string[]; tone: "ok" | "warn" | "info" }) {
  const dot = tone === "warn" ? "bg-gold" : tone === "info" ? "bg-muted" : "bg-sage";
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          <span className="text-sm text-paper/90">{label}</span>
        </div>
        <span className="text-sm tabular-nums text-faint">{count}</span>
      </div>
      {items && count > 0 && (
        <p className="mt-1.5 pl-3.5 text-xs leading-snug text-muted">
          {items.slice(0, 12).join(" · ")}{items.length > 12 ? " …" : ""}
        </p>
      )}
    </div>
  );
}
