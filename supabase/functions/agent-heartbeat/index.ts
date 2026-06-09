// =============================================================
// Study OS · agent-heartbeat  (Supabase Edge Function, Deno)
//
// The agent wakes, compiles a snapshot of one student + one course
// (profile + per-topic mastery + spine + timeline + recent actions),
// makes ONE reasoning call, and emits a small VALIDATED action set:
//   set_plan | message_student | hold
// Everything it does is logged to agent_actions. The closed action
// set is the rail; the model's freedom is in which action and when.
//
// POST { course_id, user_id }  -> heartbeat for that course (manual)
// POST { }                     -> sweep onboarded courses due a beat (cron)
// =============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("WORKER_SECRET")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const AGENT_MODEL = Deno.env.get("AGENT_MODEL") ?? "claude-haiku-4-5-20251001";
const SWEEP_GAP_HOURS = Number(Deno.env.get("HEARTBEAT_GAP_HOURS") ?? "20");
const SWEEP_LIMIT = 8;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callClaude(content: unknown[], maxTokens: number): Promise<{ text: string; usage: any }> {
  let lastErr = "call failed";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: AGENT_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
      return { text, usage: data.usage ?? {} };
    }
    lastErr = `Claude ${res.status}: ${(await res.text()).slice(0, 160)}`;
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
      const backoff = Math.min(45, Number.isFinite(ra) && ra > 0 ? ra : Math.pow(2, attempt) * 4);
      await sleep(backoff * 1000 + Math.floor(Math.random() * 800));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

function parseJSON(raw: string): any {
  let s = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(s); } catch (_) { /* */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* */ } }
  return undefined;
}

function weeksUntil(range: string | null): number | null {
  if (!range) return null;
  const m = range.match(/(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const days = (new Date(m[1] + "T00:00:00Z").getTime() - Date.now()) / 86400000;
  return Math.round(days / 7);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

async function doHeartbeat(userId: string, courseId: string, reason: string) {
  const [{ data: profile }, { data: course }] = await Promise.all([
    db.from("student_profile").select("*").eq("user_id", userId).maybeSingle(),
    db.from("courses").select("*").eq("id", courseId).single(),
  ]);
  if (!course) return;

  const { data: topics } = await db.from("course_topics")
    .select("id, title, source_count, question_count").eq("course_id", courseId).eq("level", 2);
  const { data: mastery } = await db.from("student_mastery")
    .select("topic_id, reading_state, understanding_state, last_touched").eq("user_id", userId).eq("course_id", courseId);
  const { data: lastMsgs } = await db.from("agent_messages")
    .select("body").eq("user_id", userId).eq("course_id", courseId).order("created_at", { ascending: false }).limit(1);

  const mById = new Map((mastery ?? []).map((m: any) => [m.topic_id, m]));
  const topicLines = (topics ?? []).map((t: any) => {
    const m: any = mById.get(t.id);
    const rs = m?.reading_state ?? "not_started";
    const us = m?.understanding_state ?? "unknown";
    return `- ${t.title} [read:${rs}, understanding:${us}] (questions:${t.question_count}, materials:${t.source_count})`;
  }).join("\n");

  // engagement signals
  const sinceISO = new Date(Date.now() - 14 * 86400000).toISOString();
  const { data: logs } = await db.from("study_log")
    .select("created_at").eq("user_id", userId).eq("course_id", courseId).gte("created_at", sinceISO);
  const fromMastery = (mastery ?? []).map((m: any) => m.last_touched).filter(Boolean).sort();
  const logTimes = (logs ?? []).map((l: any) => l.created_at).sort();
  const lastActivity = logTimes.length ? logTimes[logTimes.length - 1] : (fromMastery.length ? fromMastery[fromMastery.length - 1] : null);
  const daysSince = lastActivity ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / 86400000) : null;
  const dayKey = (iso: string) => new Date(iso).toISOString().slice(0, 10);
  const activeDays7 = new Set((logs ?? []).filter((l: any) => new Date(l.created_at).getTime() > Date.now() - 7 * 86400000).map((l: any) => dayKey(l.created_at))).size;

  // current plan adherence
  const { data: activePlan } = await db.from("study_plans")
    .select("id, created_at").eq("user_id", userId).eq("course_id", courseId).eq("active", true)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  let adherence = "no active plan yet";
  if (activePlan) {
    const { data: pis } = await db.from("plan_items").select("done").eq("plan_id", activePlan.id);
    const total = (pis ?? []).length, doneN = (pis ?? []).filter((p: any) => p.done).length;
    const ageDays = Math.floor((Date.now() - new Date(activePlan.created_at).getTime()) / 86400000);
    adherence = `${doneN}/${total} items done, plan is ${ageDays} day(s) old`;
  }

  const wToTest = weeksUntil(course.test_window);
  const wToExam = weeksUntil(course.exam_window);

  // this week's topics from the semester schedule (Phase 2), if one exists
  const { data: sched } = await db.from("schedule_items")
    .select("topic_id, kind").eq("user_id", userId).eq("course_id", courseId).eq("week_index", 1);
  const titleById = new Map((topics ?? []).map((t: any) => [t.id, t.title]));
  const scheduledThisWeek = (sched ?? [])
    .map((s: any) => `${titleById.get(s.topic_id) ?? ""}${s.kind === "revise" ? " (revise)" : ""}`)
    .filter((x: string) => x.trim());

  const prompt =
    "You are the study agent for ONE student in ONE university course. Your goal: keep them moving toward genuine understanding by exam time — focused, consistent, and NOT overloaded or burnt out. You also act PROACTIVELY: if they've gone quiet or are slipping, you reach out first. Be specific to this student and exactly where they are.\n\n" +
    `STUDENT\nGoal: ${profile?.semester_goal ?? "—"}\nWants to be able to: ${profile?.motivation ?? "—"}\nResponds best to: ${profile?.accountability_style ?? "—"}\nStudy hours/day: ${profile?.study_hours_per_day ?? "—"}\nHas struggled with: ${(profile?.past_struggles ?? []).join("; ") || "—"}\n\n` +
    `COURSE: ${course.title}\nTime left: ${wToTest ?? "?"} weeks to tests, ${wToExam ?? "?"} weeks to exams.\n\n` +
    `ENGAGEMENT\nLast studied: ${daysSince === null ? "not started yet" : daysSince + " day(s) ago"}.\nActive ${activeDays7} of the last 7 days.\nCurrent plan: ${adherence}.\nLast note you sent: ${lastMsgs?.[0]?.body ?? "none"}\n\n` +
    `TOPICS (their current state):\n${topicLines}\n\n` +
    (scheduledThisWeek.length ? `THIS WEEK IN THEIR SEMESTER SCHEDULE (prefer these unless they're behind on something more urgent):\n- ${scheduledThisWeek.join("\n- ")}\n\n` : "") +
    'Decide what they need RIGHT NOW. Return ONLY JSON, no fences:\n' +
    '{"situation":"1-2 sentence read of where they stand","actions":[ ... ]}\n' +
    "Allowed actions (use 1-2, choose what matters most):\n" +
    '- {"type":"set_plan","items":[{"topic":"EXACT topic title from the list","reason":"why this, one line"}]} — 3 to 6 topics, ordered, from the list ONLY. If they are overwhelmed or behind, set a SHORTER plan, not a longer one.\n' +
    '- {"type":"message_student","body":"a short, human note matched to how they like to be pushed; never shaming"} — use this to PROACTIVELY re-engage: if quiet 3+ days or adherence is low, reach out with ONE tiny, concrete re-entry step (e.g. "just 15 minutes on X today"). If they have been consistent, acknowledge it briefly. Never repeat your last note.\n' +
    '- {"type":"hold","reason":"why nothing is needed"} — use only if they were active very recently and are on track.';

  let parsed: any;
  try {
    const { text, usage } = await callClaude([{ type: "text", text: prompt }], 1500);
    await db.from("ai_usage").insert({ run_id: null, file_id: null, stage: "heartbeat", model: AGENT_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
    parsed = parseJSON(text);
  } catch (e) {
    await db.from("agent_actions").insert({ user_id: userId, course_id: courseId, type: "error", rationale: (e as Error).message.slice(0, 200) });
    return;
  }

  const situation = typeof parsed?.situation === "string" ? parsed.situation : null;
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
  const topicByNorm = new Map((topics ?? []).map((t: any) => [norm(t.title), t.id]));

  for (const a of actions) {
    if (a?.type === "set_plan" && Array.isArray(a.items)) {
      const items = a.items
        .map((it: any, i: number) => ({ topic_id: topicByNorm.get(norm(String(it?.topic ?? ""))) ?? null, order_index: i, reason: String(it?.reason ?? "").slice(0, 300) }))
        .filter((it: any) => it.topic_id)
        .slice(0, 8);
      if (items.length === 0) continue;
      await db.from("study_plans").update({ active: false }).eq("user_id", userId).eq("course_id", courseId).eq("active", true);
      const { data: plan } = await db.from("study_plans").insert({ user_id: userId, course_id: courseId, horizon: "week", situation, active: true }).select("id").single();
      if (plan) {
        await db.from("plan_items").insert(items.map((it: any) => ({ plan_id: plan.id, ...it })));
        await db.from("agent_actions").insert({ user_id: userId, course_id: courseId, type: "set_plan", rationale: situation, payload: { count: items.length } });
      }
    } else if (a?.type === "message_student" && typeof a.body === "string" && a.body.trim()) {
      await db.from("agent_messages").insert({ user_id: userId, course_id: courseId, kind: "note", body: a.body.trim().slice(0, 1500) });
      await db.from("agent_actions").insert({ user_id: userId, course_id: courseId, type: "message_student", rationale: situation });
    } else if (a?.type === "hold") {
      await db.from("agent_actions").insert({ user_id: userId, course_id: courseId, type: "hold", rationale: String(a.reason ?? "").slice(0, 300) });
    }
  }
}

async function sweep() {
  const { data: courses } = await db.from("courses").select("id, user_id").eq("status", "onboarded").limit(50);
  let done = 0;
  for (const c of courses ?? []) {
    if (done >= SWEEP_LIMIT) break;
    const since = new Date(Date.now() - SWEEP_GAP_HOURS * 3600000).toISOString();
    // run a beat if the agent hasn't done anything for this course recently
    const { count } = await db.from("agent_actions").select("id", { count: "exact", head: true })
      .eq("course_id", c.id).gt("created_at", since);
    if ((count ?? 0) > 0) continue; // checked in recently
    try { await doHeartbeat(c.user_id, c.id, "daily"); done++; } catch (_) { /* keep sweeping */ }
  }
}

Deno.serve(async (req) => {
  if (req.headers.get("x-worker-secret") !== WORKER_SECRET) return new Response("forbidden", { status: 403 });
  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }

  if (body.course_id) {
    let userId = body.user_id;
    if (!userId) {
      const { data: c } = await db.from("courses").select("user_id").eq("id", body.course_id).single();
      userId = c?.user_id;
    }
    if (userId) await doHeartbeat(userId, body.course_id, body.reason ?? "manual");
  } else {
    await sweep();
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
