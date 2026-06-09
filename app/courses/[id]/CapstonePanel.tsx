"use client";

import { useEffect, useRef, useState } from "react";
import { ensureSession } from "@/lib/supabase/client";
import type { Capstone, CapstoneMilestone } from "@/lib/types";

export default function CapstonePanel({ courseId }: { courseId: string }) {
  const supaRef = useRef<Awaited<ReturnType<typeof ensureSession>> | null>(null);
  const [caps, setCaps] = useState<Capstone[]>([]);
  const [milestones, setMilestones] = useState<CapstoneMilestone[]>([]);
  const [solid, setSolid] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);

  async function loadAll(supabase: any) {
    const { data: cs } = await supabase.from("capstones").select("*").eq("course_id", courseId).order("created_at", { ascending: false });
    const list = (cs as Capstone[]) ?? [];
    setCaps(list);
    const active = list.find((c) => c.status === "active");
    if (active) {
      const { data: ms } = await supabase.from("capstone_milestones").select("*").eq("capstone_id", active.id).order("order_index");
      setMilestones((ms as CapstoneMilestone[]) ?? []);
    } else setMilestones([]);
  }

  useEffect(() => {
    let channel: any = null;
    (async () => {
      const supabase = await ensureSession();
      supaRef.current = supabase;
      const { data: tp } = await supabase.from("course_topics").select("id, title").eq("course_id", courseId);
      setTitles(new Map((tp ?? []).map((t: any) => [t.id, t.title])));
      const { data: ms } = await supabase.from("student_mastery").select("topic_id, understanding_state").eq("course_id", courseId);
      setSolid(new Set((ms ?? []).filter((m: any) => m.understanding_state === "solid").map((m: any) => m.topic_id)));
      await loadAll(supabase);
      channel = supabase.channel(`cap-${courseId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "capstones", filter: `course_id=eq.${courseId}` }, () => { loadAll(supabase); setBusy(null); })
        .on("postgres_changes", { event: "*", schema: "public", table: "capstone_milestones" }, () => { loadAll(supabase); setBusy(null); })
        .on("postgres_changes", { event: "*", schema: "public", table: "student_mastery", filter: `course_id=eq.${courseId}` },
          (p: any) => { const r = p.new; if (r?.topic_id) setSolid((prev) => { const n = new Set(prev); if (r.understanding_state === "solid") n.add(r.topic_id); else n.delete(r.topic_id); return n; }); })
        .subscribe();
    })();
    return () => { if (channel) channel.unsubscribe(); };
  }, [courseId]);

  async function call(mode: string, extra: Record<string, unknown>, key: string) {
    setBusy(key);
    try { await fetch("/api/coach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, ...extra }) }); } catch { /* */ }
    setTimeout(() => setBusy(null), 90000);
  }
  const propose = () => call("capstone_propose", { courseId }, "propose");
  const plan = (capstoneId: string) => call("capstone_plan", { capstoneId }, "plan");

  async function choose(c: Capstone) {
    const supabase = supaRef.current!;
    await supabase.from("capstones").update({ status: "active", updated_at: new Date().toISOString() }).eq("id", c.id);
    await loadAll(supabase);
  }
  async function toggleMilestone(m: CapstoneMilestone) {
    const supabase = supaRef.current!;
    const done = !m.done;
    setMilestones((prev) => prev.map((x) => (x.id === m.id ? { ...x, done } : x)));
    await supabase.from("capstone_milestones").update({ done }).eq("id", m.id);
  }

  const active = caps.find((c) => c.status === "active");
  const proposed = caps.filter((c) => c.status === "proposed");
  const unlocked = (m: CapstoneMilestone) => (m.required_topic_ids ?? []).every((id) => solid.has(id));
  const doneN = milestones.filter((m) => m.done).length;

  return (
    <section className="mb-10 rounded-xl border border-gold/15 bg-gradient-to-b from-gold/[0.03] to-transparent p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="label text-gold-dim">Capstone</h2>
        {!active && (
          <button onClick={propose} disabled={busy === "propose"} className="rounded-full border border-gold/40 px-3 py-1.5 text-xs text-gold transition hover:bg-gold/10 disabled:opacity-50">
            {busy === "propose" ? "Thinking…" : proposed.length ? "Re-propose" : "Propose capstones"}
          </button>
        )}
      </div>

      {!active && proposed.length === 0 && (
        <p className="text-sm text-muted">The visible end-goal that pulls the whole course together — a real paper or project you build as you learn. Propose a few ideas grounded in this course.</p>
      )}

      {!active && proposed.length > 0 && (
        <div className="space-y-2">
          <p className="mb-1 text-xs text-faint">Pick one to make it your capstone — its milestones will unlock as you master the topics they need.</p>
          {proposed.map((c) => (
            <div key={c.id} className="rounded-lg bg-raised/60 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-paper">{c.title} <span className="ml-1 label text-faint">{c.kind}</span></p>
                  {c.summary && <p className="mt-0.5 text-xs text-muted">{c.summary}</p>}
                </div>
                <button onClick={() => choose(c)} className="shrink-0 rounded-full border border-gold/40 px-3 py-1 text-[11px] text-gold transition hover:bg-gold/10">Choose</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {active && (
        <div>
          <p className="text-sm text-paper">{active.title} <span className="ml-1 label text-faint">{active.kind}</span></p>
          {active.summary && <p className="mt-0.5 mb-3 text-xs text-muted">{active.summary}</p>}

          {milestones.length === 0 ? (
            <button onClick={() => plan(active.id)} disabled={busy === "plan"} className="rounded-full border border-gold/40 px-3 py-1.5 text-xs text-gold transition hover:bg-gold/10 disabled:opacity-50">
              {busy === "plan" ? "Planning…" : "Plan milestones"}
            </button>
          ) : (
            <>
              <div className="mb-3">
                <div className="h-1 overflow-hidden rounded-full bg-line">
                  <div className="h-full bg-gold" style={{ width: `${Math.round((doneN / milestones.length) * 100)}%` }} />
                </div>
                <p className="mt-1 text-[11px] text-faint">{doneN}/{milestones.length} milestones · unlocks as you master the topics each needs</p>
              </div>
              <ol className="space-y-2">
                {milestones.map((m) => {
                  const open = unlocked(m);
                  const need = (m.required_topic_ids ?? []).map((id) => ({ id, title: titles.get(id) ?? "—", ok: solid.has(id) }));
                  return (
                    <li key={m.id} className={`rounded-lg px-4 py-3 ${open ? "bg-ink" : "bg-surface/20"}`}>
                      <div className="flex items-start gap-2">
                        {open ? (
                          <input type="checkbox" checked={m.done} onChange={() => toggleMilestone(m)} className="mt-0.5 accent-gold" />
                        ) : (
                          <span className="mt-0.5 text-faint" title="Locked until prerequisites are solid">🔒</span>
                        )}
                        <div className="min-w-0">
                          <p className={`text-sm ${m.done ? "text-faint line-through" : open ? "text-paper/90" : "text-muted"}`}>{m.title}</p>
                          {m.detail && <p className="mt-0.5 text-xs text-muted">{m.detail}</p>}
                          {need.length > 0 && (
                            <p className="mt-1 text-[11px] text-faint">
                              Needs: {need.map((n, i) => (
                                <span key={n.id} className={n.ok ? "text-sage" : "text-faint"}>{n.title}{n.ok ? " ✓" : ""}{i < need.length - 1 ? ", " : ""}</span>
                              ))}
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  );
}
