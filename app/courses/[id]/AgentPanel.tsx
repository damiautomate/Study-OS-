"use client";

import { useEffect, useRef, useState } from "react";
import { ensureSession } from "@/lib/supabase/client";
import type { StudyPlan, PlanItem, AgentMessage, StudentMastery, Coaching, ApplicationNote } from "@/lib/types";

const UNDERSTANDING = [
  { key: "shaky", label: "Shaky" },
  { key: "developing", label: "Getting it" },
  { key: "solid", label: "Solid" },
];

export default function AgentPanel({ courseId }: { courseId: string }) {
  const [uid, setUid] = useState<string | null>(null);
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [items, setItems] = useState<PlanItem[]>([]);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [mastery, setMastery] = useState<Map<string, StudentMastery>>(new Map());
  const [materials, setMaterials] = useState<Map<string, { id: string; name: string }[]>>(new Map());
  const [qByTopic, setQByTopic] = useState<Map<string, number>>(new Map());
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [eng, setEng] = useState<{ days: number | null; active7: number }>({ days: null, active7: 0 });
  const [thinking, setThinking] = useState(false);
  const [coaching, setCoaching] = useState<Coaching[]>([]);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [appNotes, setAppNotes] = useState<Map<string, ApplicationNote>>(new Map());
  const supaRef = useRef<Awaited<ReturnType<typeof ensureSession>> | null>(null);

  async function loadPlan(supabase: any) {
    const { data: p } = await supabase
      .from("study_plans").select("*").eq("course_id", courseId).eq("active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    setPlan((p as StudyPlan) ?? null);
    if (p) {
      const { data: it } = await supabase.from("plan_items").select("*").eq("plan_id", p.id).order("order_index");
      setItems((it as PlanItem[]) ?? []);
      setThinking(false);
    }
  }

  useEffect(() => {
    let channel: any = null;
    (async () => {
      const supabase = await ensureSession();
      supaRef.current = supabase;
      const { data: auth } = await supabase.auth.getUser();
      setUid(auth.user?.id ?? null);

      const { data: tp } = await supabase.from("course_topics").select("id, title, source_file_ids").eq("course_id", courseId).eq("level", 2);
      setTitles(new Map((tp ?? []).map((t: any) => [t.id, t.title])));
      const { data: sf } = await supabase.from("source_files").select("id, original_path").eq("course_id", courseId);
      const nameById = new Map((sf ?? []).map((f: any) => [f.id, String(f.original_path).split("/").pop()]));
      setMaterials(new Map((tp ?? []).map((t: any) => [
        t.id,
        (Array.isArray(t.source_file_ids) ? t.source_file_ids : [])
          .map((id: string) => ({ id, name: nameById.get(id) as string }))
          .filter((m: any) => m.name),
      ])));
      const { data: qd } = await supabase.from("questions").select("topic_id").eq("course_id", courseId);
      const qmap = new Map<string, number>();
      for (const q of qd ?? []) if (q.topic_id) qmap.set(q.topic_id, (qmap.get(q.topic_id) ?? 0) + 1);
      setQByTopic(qmap);

      const { data: ms } = await supabase.from("student_mastery").select("*").eq("course_id", courseId);
      setMastery(new Map((ms ?? []).map((m: any) => [m.topic_id, m])));

      const { data: msg } = await supabase.from("agent_messages").select("*").eq("course_id", courseId)
        .order("created_at", { ascending: false }).limit(4);
      const msgs = (msg as AgentMessage[]) ?? [];
      setMessages(msgs);

      const sinceISO = new Date(Date.now() - 14 * 86400000).toISOString();
      const { data: logs } = await supabase.from("study_log").select("created_at").eq("course_id", courseId).gte("created_at", sinceISO);
      const times = (logs ?? []).map((l: any) => new Date(l.created_at).getTime());
      const last = times.length ? Math.max(...times) : null;
      const active7 = new Set((logs ?? [])
        .filter((l: any) => new Date(l.created_at).getTime() > Date.now() - 7 * 86400000)
        .map((l: any) => new Date(l.created_at).toISOString().slice(0, 10))).size;
      setEng({ days: last ? Math.floor((Date.now() - last) / 86400000) : null, active7 });

      const { data: co } = await supabase.from("coaching").select("*").eq("course_id", courseId).order("created_at", { ascending: true });
      setCoaching((co as Coaching[]) ?? []);

      const { data: an } = await supabase.from("application_notes").select("*").eq("course_id", courseId);
      setAppNotes(new Map((an as ApplicationNote[] ?? []).filter((n) => n.topic_id).map((n) => [n.topic_id as string, n])));

      await loadPlan(supabase);

      channel = supabase.channel(`agent-${courseId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "study_plans", filter: `course_id=eq.${courseId}` },
          () => loadPlan(supabase))
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_messages", filter: `course_id=eq.${courseId}` },
          (p) => { const row = p.new as AgentMessage; setMessages((prev) => [row, ...prev].slice(0, 5)); setThinking(false); })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "coaching", filter: `course_id=eq.${courseId}` },
          (p) => {
            const row = p.new as Coaching;
            setCoaching((prev) => [...prev, row]);
            setPending((prev) => {
              const n = new Set(prev);
              if (row.topic_id) {
                if (row.mode === "check") n.delete(`${row.topic_id}:check:${(row.meta as any)?.question_id}`);
                else n.delete(`${row.topic_id}:${row.mode}`);
              }
              return n;
            });
          })
        .on("postgres_changes", { event: "*", schema: "public", table: "student_mastery", filter: `course_id=eq.${courseId}` },
          (p) => { const row = p.new as StudentMastery; if (row?.topic_id) setMastery((prev) => { const n = new Map(prev); n.set(row.topic_id, row); return n; }); })
        .on("postgres_changes", { event: "*", schema: "public", table: "application_notes", filter: `course_id=eq.${courseId}` },
          (p) => {
            const row = p.new as ApplicationNote;
            if (row?.topic_id) {
              setAppNotes((prev) => { const n = new Map(prev); n.set(row.topic_id as string, row); return n; });
              setPending((prev) => { const n = new Set(prev); n.delete(`${row.topic_id}:application`); return n; });
            }
          })
        .subscribe();
    })();
    return () => { if (channel) channel.unsubscribe(); };
  }, [courseId]);

  async function openMaterial(fileId: string, topicId?: string) {
    try {
      const res = await fetch("/api/material", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId }) });
      const json = await res.json();
      if (json.url) window.open(json.url, "_blank");
      if (topicId && mastery.get(topicId)?.reading_state !== "read") {
        await touch(topicId, { reading_state: "in_progress" }, "read");
      }
    } catch { /* */ }
  }

  async function planMyWeek() {
    setThinking(true);
    try {
      await fetch("/api/heartbeat", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId }),
      });
    } catch { /* */ }
    setTimeout(() => setThinking(false), 60000); // safety: clear if nothing arrives
  }

  async function touch(topicId: string, patch: Partial<StudentMastery>, kind: string) {
    const supabase = supaRef.current!;
    const now = new Date().toISOString();
    await supabase.from("student_mastery").upsert(
      { course_id: courseId, topic_id: topicId, last_touched: now, ...patch },
      { onConflict: "user_id,topic_id" },
    );
    if (uid) await supabase.from("student_profile").update({ last_active_at: now }).eq("user_id", uid);
    await supabase.from("study_log").insert({ course_id: courseId, topic_id: topicId, kind });
    setMastery((prev) => {
      const next = new Map(prev);
      const cur = (next.get(topicId) ?? {}) as StudentMastery;
      next.set(topicId, { ...cur, topic_id: topicId, last_touched: now, ...patch } as StudentMastery);
      return next;
    });
  }

  async function openApplication(topicId: string) {
    if (appNotes.has(topicId)) return; // cached — already shown below
    setPending((prev) => new Set(prev).add(`${topicId}:application`));
    try {
      await fetch("/api/coach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, topicId, mode: "application" }) });
    } catch { /* */ }
    setTimeout(() => setPending((prev) => { const n = new Set(prev); n.delete(`${topicId}:application`); return n; }), 90000);
  }

  async function checkAnswer(topicId: string, questionId: string) {
    const ans = (answers[questionId] ?? "").trim();
    if (!ans) return;
    setPending((prev) => new Set(prev).add(`${topicId}:check:${questionId}`));
    try {
      await fetch("/api/coach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, topicId, mode: "check", questionId, answer: ans }) });
    } catch { /* */ }
    setTimeout(() => setPending((prev) => { const n = new Set(prev); n.delete(`${topicId}:check:${questionId}`); return n; }), 60000);
  }

  async function runCoach(topicId: string, mode: "explain" | "practice" | "hook") {
    setPending((prev) => new Set(prev).add(`${topicId}:${mode}`));
    try {
      await fetch("/api/coach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, topicId, mode }) });
    } catch { /* */ }
    setTimeout(() => setPending((prev) => { const n = new Set(prev); n.delete(`${topicId}:${mode}`); return n; }), 60000);
  }

  async function toggleDone(item: PlanItem) {
    const supabase = supaRef.current!;
    const done = !item.done;
    await supabase.from("plan_items").update({ done }).eq("id", item.id);
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, done } : i)));
    if (done && item.topic_id) await touch(item.topic_id, { reading_state: "read" }, "studied");
  }

  return (
    <section className="mb-10 rounded-xl border border-gold/20 bg-gradient-to-b from-gold/[0.04] to-transparent p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="label text-gold-dim">Your agent</h2>
        <button onClick={planMyWeek} disabled={thinking}
          className="rounded-full border border-gold/40 px-3 py-1.5 text-xs text-gold transition hover:bg-gold/10 disabled:opacity-50">
          {thinking ? "Thinking…" : plan ? "Re-plan" : "Plan my week"}
        </button>
      </div>

      <p className="mb-4 text-[11px] text-faint">
        {eng.days === null ? "Not started yet" : `Last studied ${eng.days === 0 ? "today" : eng.days + " day" + (eng.days === 1 ? "" : "s") + " ago"}`} · active {eng.active7} of last 7 days
      </p>

      {messages.length > 0 && (
        <div className="mb-5 space-y-2">
          {messages.slice(0, 3).map((mm, i) => (
            <div key={mm.id} className={`rounded-lg px-4 py-3 text-sm leading-relaxed ${i === 0 ? "bg-raised/70 text-paper/90" : "bg-raised/50 text-muted"}`}>
              {mm.body}
            </div>
          ))}
        </div>
      )}

      {plan ? (
        <>
          {plan.situation && <p className="mb-3 text-xs italic text-muted">{plan.situation}</p>}
          <ol className="space-y-3">
            {items.map((item) => {
              const m = item.topic_id ? mastery.get(item.topic_id) : undefined;
              return (
                <li key={item.id} className="rounded-lg border border-line bg-surface px-4 py-3">
                  <div className="flex items-start gap-3">
                    <button onClick={() => toggleDone(item)}
                      className={`mt-0.5 h-4 w-4 shrink-0 rounded border ${item.done ? "border-sage bg-sage/30" : "border-line"}`}
                      aria-label="toggle done" />
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm ${item.done ? "text-faint line-through" : "text-paper/90"}`}>
                        {item.topic_id ? titles.get(item.topic_id) ?? "Topic" : "Topic"}
                      </p>
                      {item.reason && <p className="mt-0.5 text-xs text-muted">{item.reason}</p>}
                      {item.topic_id && (
                        <div className="mt-1 text-[11px] text-faint">
                          {materials.get(item.topic_id)?.length ? (
                            <span>
                              Read:{" "}
                              {materials.get(item.topic_id)!.map((m, idx, arr) => (
                                <span key={m.id}>
                                  <button onClick={() => openMaterial(m.id, item.topic_id!)} className="text-gold-dim underline-offset-2 hover:underline">{m.name}</button>
                                  {idx < arr.length - 1 ? ", " : ""}
                                </span>
                              ))}
                            </span>
                          ) : "No notes tagged"}
                          {qByTopic.get(item.topic_id) ? ` · ${qByTopic.get(item.topic_id)} question${qByTopic.get(item.topic_id) === 1 ? "" : "s"}` : ""}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {UNDERSTANDING.map((u) => (
                          <button key={u.key}
                            onClick={() => item.topic_id && touch(item.topic_id, { understanding_state: u.key as StudentMastery["understanding_state"] }, "studied")}
                            className={`rounded-full border px-2 py-0.5 text-[10px] transition ${
                              m?.understanding_state === u.key ? "border-sage text-sage" : "border-line text-faint hover:border-muted"
                            }`}>
                            {u.label}
                          </button>
                        ))}
                      </div>

                      {item.topic_id && (
                        <div className="mt-3 border-t border-line/60 pt-3">
                          <div className="flex flex-wrap gap-1.5">
                            {([["explain", "Explain"], ["practice", "Practice"]] as const).map(([mode, label]) => (
                              <button key={mode} onClick={() => runCoach(item.topic_id!, mode)}
                                className="rounded-full border border-gold/30 px-2.5 py-0.5 text-[10px] text-gold-dim transition hover:bg-gold/10">
                                {label}
                              </button>
                            ))}
                            <button onClick={() => openApplication(item.topic_id!)}
                              className="rounded-full border border-gold/30 px-2.5 py-0.5 text-[10px] text-gold-dim transition hover:bg-gold/10">
                              Why it matters
                            </button>
                          </div>
                          {(["explain", "practice"] as const).map((mode) => {
                            const key = `${item.topic_id}:${mode}`;
                            const isPending = pending.has(key);
                            const entries = coaching.filter((c) => c.topic_id === item.topic_id && c.mode === mode);
                            const latest = entries[entries.length - 1];
                            if (!isPending && !latest) return null;
                            const qid = mode === "practice" ? ((latest?.meta as any)?.question_id as string | undefined) : undefined;
                            const checks = qid ? coaching.filter((c) => c.mode === "check" && (c.meta as any)?.question_id === qid) : [];
                            const lastCheck = checks[checks.length - 1];
                            const checkPending = qid ? pending.has(`${item.topic_id}:check:${qid}`) : false;
                            const cv = (lastCheck?.meta as any)?.verdict as string | undefined;
                            const vColor = cv === "correct" ? "text-sage" : cv === "incorrect" ? "text-rust" : "text-gold";
                            return (
                              <div key={mode} className="mt-2 rounded-lg bg-raised/70 px-3 py-2">
                                <p className="mb-1 label text-faint">{mode}</p>
                                {isPending && !latest
                                  ? <p className="text-xs text-muted">thinking…</p>
                                  : <p className="whitespace-pre-wrap text-xs leading-relaxed text-paper/85">{latest?.body}</p>}
                                {mode === "practice" && qid && (
                                  <div className="mt-2">
                                    <textarea
                                      value={answers[qid] ?? ""}
                                      onChange={(e) => setAnswers((prev) => ({ ...prev, [qid]: e.target.value }))}
                                      placeholder="Work it out, then write your answer here…"
                                      rows={3}
                                      className="w-full rounded-md border border-line bg-ink px-2.5 py-2 text-xs text-paper outline-none focus:border-gold-dim"
                                    />
                                    <button
                                      onClick={() => checkAnswer(item.topic_id!, qid)}
                                      disabled={checkPending || !(answers[qid] ?? "").trim()}
                                      className="mt-1.5 rounded-full border border-gold/40 px-3 py-1 text-[10px] text-gold transition hover:bg-gold/10 disabled:opacity-40">
                                      {checkPending ? "Checking…" : "Check my answer"}
                                    </button>
                                    {lastCheck && (
                                      <div className="mt-2 rounded-md bg-raised px-2.5 py-2">
                                        <p className={`mb-1 label ${vColor}`}>
                                          {cv ?? "checked"}{typeof (lastCheck.meta as any)?.score === "number" ? ` · ${(lastCheck.meta as any).score}/100` : ""}
                                          {(lastCheck.meta as any)?.graded_on === "materials_only" ? " · no official key" : ""}
                                        </p>
                                        <p className="whitespace-pre-wrap text-xs leading-relaxed text-paper/85">{lastCheck.body}</p>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {item.topic_id && (appNotes.get(item.topic_id) || pending.has(`${item.topic_id}:application`)) && (
                            <div className="mt-2 rounded-lg border border-gold/25 bg-gold/[0.05] px-3 py-2.5">
                              <p className="mb-1.5 label text-gold-dim">Why this matters</p>
                              {!appNotes.get(item.topic_id) ? (
                                <p className="text-xs text-muted">finding real-world uses…</p>
                              ) : (
                                <div className="space-y-2">
                                  {appNotes.get(item.topic_id)!.why && (
                                    <p className="text-xs leading-relaxed text-paper/90">{appNotes.get(item.topic_id)!.why}</p>
                                  )}
                                  {appNotes.get(item.topic_id)!.uses?.length ? (
                                    <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted">
                                      {appNotes.get(item.topic_id)!.uses!.map((u, i) => <li key={i}>{u}</li>)}
                                    </ul>
                                  ) : null}
                                  {appNotes.get(item.topic_id)!.cross_links?.length ? (
                                    <div className="text-[11px] text-muted">
                                      <span className="text-faint">Connects to your other courses:</span>
                                      {appNotes.get(item.topic_id)!.cross_links!.map((l, i) => (
                                        <div key={i} className="mt-0.5">↳ <span className="text-paper/80">{l.course}</span>{l.topic ? ` · ${l.topic}` : ""} — {l.link}</div>
                                      ))}
                                    </div>
                                  ) : null}
                                  {appNotes.get(item.topic_id)!.sources?.length ? (
                                    <p className="text-[11px] text-faint">
                                      Sources:{" "}
                                      {appNotes.get(item.topic_id)!.sources!.map((s, i, arr) => (
                                        <span key={i}>
                                          <a href={s.url} target="_blank" rel="noreferrer" className="text-gold-dim underline-offset-2 hover:underline">{s.title}</a>{i < arr.length - 1 ? ", " : ""}
                                        </span>
                                      ))}
                                    </p>
                                  ) : null}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <p className="text-sm text-muted">
          {thinking ? "Your agent is looking at where you stand…" : "No plan yet. Tap \u201CPlan my week\u201D and the agent will build one from where you are."}
        </p>
      )}
    </section>
  );
}
