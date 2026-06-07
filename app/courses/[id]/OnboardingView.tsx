"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ensureSession } from "@/lib/supabase/client";
import type { Course, OnboardingRun, RunEvent, SourceFile } from "@/lib/types";

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

export default function OnboardingView({ courseId }: { courseId: string }) {
  const [course, setCourse] = useState<Course | null>(null);
  const [run, setRun] = useState<OnboardingRun | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [loaded, setLoaded] = useState(false);
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

  if (loaded && !run) {
    return (
      <main className="mx-auto max-w-2xl px-5 py-16">
        <Link href="/" className="text-xs text-faint hover:text-muted">← all courses</Link>
        <p className="mt-8 text-muted">No onboarding run found for this course.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-12 sm:py-16">
      <Link href="/" className="text-xs text-faint hover:text-muted">← all courses</Link>

      <header className="mt-6 mb-10">
        <h1 className="text-3xl sm:text-4xl text-paper">{course?.title ?? "Course"}</h1>
        {course?.code && <p className="text-sm text-faint mt-1">{course.code}</p>}
      </header>

      {/* progress */}
      <div className="mb-8">
        <div className="flex items-center justify-between text-xs mb-2">
          <span className="uppercase tracking-[0.2em] text-muted">
            {isFailed ? "Stopped" : isDone ? "Inventory ready" : "Onboarding"}
          </span>
          <span className="text-faint">{total ? `${processed} / ${total}` : ""}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
          <div
            className={`h-full rounded-full transition-all duration-500 ${isFailed ? "bg-rust" : isDone ? "bg-sage" : "bg-gold"}`}
            style={{ width: `${isDone ? 100 : pct}%` }}
          />
        </div>
      </div>

      {/* live feed */}
      <section className="mb-10 rounded-xl border border-line bg-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          {!isDone && !isFailed && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-gold" />}
          <h2 className="text-xs uppercase tracking-[0.2em] text-muted">Activity</h2>
        </div>
        <ol className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {events.map((e) => (
            <li key={e.id} className="rise text-sm leading-relaxed">
              <span className="mr-2 text-faint tabular-nums text-[11px]">
                {new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className={EVENT_TONE[e.kind] ?? "text-muted"}>{e.message}</span>
            </li>
          ))}
          <div ref={feedEnd} />
        </ol>
      </section>

      {/* inventory */}
      {files.length > 0 && (
        <section>
          <h2 className="mb-4 text-xs uppercase tracking-[0.2em] text-muted">Inventory</h2>
          <div className="space-y-6">
            {order.filter((k) => groups[k]?.length).map((k) => (
              <div key={k}>
                <div className="mb-2 flex items-center gap-2">
                  <span className={`text-sm font-medium ${STATUS_TONE[k]}`}>{STATUS_LABEL[k]}</span>
                  <span className="text-xs text-faint">({groups[k].length})</span>
                </div>
                <ul className="space-y-1.5">
                  {groups[k].map((f) => (
                    <li key={f.id} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="truncate text-paper/90">{f.original_path.split("/").pop()}</span>
                      <span className="shrink-0 text-[11px] text-faint">
                        {f.page_count ? `${f.page_count}p` : ""}
                        {f.note && k !== "read" ? ` · ${f.note}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
