// =============================================================
// Study OS · agent-coach  (Supabase Edge Function, Deno)
//
// On-demand coaching, grounded in the student's own materials:
//   explain  -> teach the topic from its own source pages
//   practice -> pull a real past question and scaffold it into steps
//   hook     -> what the topic is actually used for (web search)
//
// POST { mode, course_id, topic_id, user_id, question_id? }
// Writes a coaching row; the UI picks it up via Realtime.
// =============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("WORKER_SECRET")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const COACH_MODEL = Deno.env.get("COACH_MODEL") ?? "claude-haiku-4-5-20251001";
const BUCKET = "course-uploads";
const MAX_MATERIAL_CHARS = Number(Deno.env.get("MAX_UNDERSTAND_CHARS") ?? "30000");

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callClaude(content: unknown[], maxTokens: number, tools?: unknown[]): Promise<string> {
  let lastErr = "call failed";
  for (let attempt = 0; attempt < 4; attempt++) {
    const payload: any = { model: COACH_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] };
    if (tools) payload.tools = tools;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
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

async function materialText(topic: any): Promise<string> {
  const ids: string[] = Array.isArray(topic.source_file_ids) ? topic.source_file_ids : [];
  if (ids.length === 0) return "";
  const { data: files } = await db.from("source_files").select("text_path").in("id", ids.slice(0, 5));
  let out = "";
  for (const f of files ?? []) {
    if (!f.text_path || out.length >= MAX_MATERIAL_CHARS) continue;
    const dl = await db.storage.from(BUCKET).download(f.text_path);
    if (!dl.error && dl.data) out += (await dl.data.text()).slice(0, MAX_MATERIAL_CHARS - out.length) + "\n\n";
  }
  return out;
}

async function coach(args: any) {
  const { mode, course_id, topic_id, user_id, question_id } = args;
  const { data: topic } = await db.from("course_topics").select("*").eq("id", topic_id).single();
  const { data: course } = await db.from("courses").select("title").eq("id", course_id).single();
  if (!topic) return;
  const title = topic.title;
  const courseTitle = course?.title ?? "the course";

  let body = "";
  const meta: any = {};

  try {
    if (mode === "explain") {
      const text = await materialText(topic);
      const prompt = text
        ? `You are tutoring a student in ${courseTitle}. Explain the topic "${title}" clearly and in a logical structure, exactly as their course teaches it — base it on the course material below and use the same notation. Be concrete. End with one short self-check question. Keep it focused.\n\nCOURSE MATERIAL:\n${text}`
        : `You are tutoring a student in ${courseTitle}. Explain the topic "${title}" clearly and concretely for a university student. End with one short self-check question. (Note: no specific course material was found for this topic.)`;
      body = await callClaude([{ type: "text", text: prompt }], 1800);
    } else if (mode === "practice") {
      let q: any = null;
      if (question_id) {
        const { data } = await db.from("questions").select("*").eq("id", question_id).single();
        q = data;
      } else {
        const { data } = await db.from("questions").select("*").eq("topic_id", topic_id).limit(10);
        if (data && data.length) q = data[Math.floor(Math.random() * data.length)];
      }
      if (!q) {
        body = `There's no past question tagged to "${title}" yet. (You can add more materials later and it'll fill in.)`;
      } else {
        meta.question_id = q.id;
        const steps = await callClaude([{ type: "text", text:
          `A student is working on this past question from ${courseTitle} on "${title}". Do NOT give the full answer. Break it into a short ordered list of doable steps that guide them to solve it themselves; name the key idea each step uses.\n\nQUESTION:\n${q.question_text}` }], 1200);
        body = `**Question:** ${q.question_text}\n\n**How to approach it:**\n${steps}`;
      }
    } else if (mode === "hook") {
      const text = await callClaude(
        [{ type: "text", text: `In 3-5 sentences, what is "${title}" (from ${courseTitle}) actually used for in the real world — engineering, industry, or research? Give a concrete, motivating example a student would find compelling. Use web search for current, real examples.` }],
        1200,
        [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      );
      body = text;
    } else {
      return;
    }
  } catch (e) {
    body = `Couldn't generate this right now (${(e as Error).message.slice(0, 120)}). Try again in a moment.`;
  }

  await db.from("coaching").insert({ user_id, course_id, topic_id, question_id: meta.question_id ?? null, mode, body, meta });
  await db.from("agent_actions").insert({ user_id, course_id, type: `coach_${mode}`, rationale: title });
}

Deno.serve(async (req) => {
  if (req.headers.get("x-worker-secret") !== WORKER_SECRET) return new Response("forbidden", { status: 403 });
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* */ }
  if (body.mode && body.course_id && body.topic_id && body.user_id) {
    await coach(body);
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
