"use client";

import { useEffect, useRef, useState } from "react";
import { ensureSession } from "@/lib/supabase/client";
import type { StudyPlan, PlanItem, AgentMessage, StudentMastery } from "@/lib/types";

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
  const [message, setMessage] = useState<AgentMessage | null>(null);
  const [thinking, setThinking] = useState(false);
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

      const { data: tp } = await supabase.from("course_topics").select("id, title").eq("course_id", courseId).eq("level", 2);
      setTitles(new Map((tp ?? []).map((t: any) => [t.id, t.title])));

      const { data: ms } = await supabase.from("student_mastery").select("*").eq("course_id", courseId);
      setMastery(new Map((ms ?? []).map((m: any) => [m.topic_id, m])));

      const { data: msg } = await supabase.from("agent_messages").select("*").eq("course_id", courseId)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      setMessage((msg as AgentMessage) ?? null);

      await loadPlan(supabase);

      channel = supabase.channel(`agent-${courseId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "study_plans", filter: `course_id=eq.${courseId}` },
          () => loadPlan(supabase))
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_messages", filter: `course_id=eq.${courseId}` },
          (p) => { setMessage(p.new as AgentMessage); setThinking(false); })
        .subscribe();
    })();
    return () => { if (channel) channel.unsubscribe(); };
  }, [courseId]);

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
        <h2 className="text-xs uppercase tracking-[0.2em] text-gold-dim">Your agent</h2>
        <button onClick={planMyWeek} disabled={thinking}
          className="rounded-full border border-gold/40 px-3 py-1.5 text-xs text-gold transition hover:bg-gold/10 disabled:opacity-50">
          {thinking ? "Thinking…" : plan ? "Re-plan" : "Plan my week"}
        </button>
      </div>

      {message && (
        <div className="mb-5 rounded-lg bg-surface/80 px-4 py-3 text-sm leading-relaxed text-paper/90">
          {message.body}
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
