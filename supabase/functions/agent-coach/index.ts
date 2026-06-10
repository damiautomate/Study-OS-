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

// Checkpoint self-trigger: kick off a Phase-6 application note without blocking the caller.
function fireApplication(args: { course_id: string; topic_id: string; user_id: string }) {
  const p = fetch(`${SUPABASE_URL}/functions/v1/agent-coach`, {
    method: "POST",
    headers: { "x-worker-secret": WORKER_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ ...args, mode: "application" }),
  }).catch(() => {});
  try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch (_) { /* */ }
}

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

// "12-18,21" -> Set of page numbers
function parsePages(spec: string | null): Set<number> | null {
  if (!spec) return null;
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = a; i <= Math.min(b, a + 400); i++) out.add(i);
  }
  return out.size ? out : null;
}

// keep only the [[PAGE n]] sections whose n is in the set
function sliceByPages(text: string, pages: Set<number>): string {
  const parts = text.split(/\[\[PAGE (\d+)\]\]/);
  if (parts.length < 3) return text; // no markers (legacy text) — use whole
  let out = "";
  for (let i = 1; i < parts.length; i += 2) {
    const n = parseInt(parts[i], 10);
    if (pages.has(n)) out += `[p.${n}] ${parts[i + 1] ?? ""}\n`;
  }
  return out.trim();
}

async function materialText(topic: any): Promise<string> {
  // prefer page-level refs (exact pages a topic uses)
  const { data: refs } = await db.from("material_refs").select("file_id, pages").eq("topic_id", topic.id).limit(6);
  let out = "";
  if (refs && refs.length) {
    const { data: files } = await db.from("source_files").select("id, original_path, text_path").in("id", refs.map((r: any) => r.file_id));
    const byId = new Map((files ?? []).map((f: any) => [f.id, f]));
    for (const r of refs) {
      const f = byId.get(r.file_id);
      if (!f?.text_path || out.length >= MAX_MATERIAL_CHARS) continue;
      const dl = await db.storage.from(BUCKET).download(f.text_path);
      if (dl.error || !dl.data) continue;
      const full = await dl.data.text();
      const pset = parsePages(r.pages);
      const sliced = pset ? sliceByPages(full, pset) : full;
      const name = String(f.original_path).split("/").pop();
      out += `--- From ${name}${r.pages ? ` (pages ${r.pages})` : ""} ---\n` + sliced.slice(0, MAX_MATERIAL_CHARS - out.length) + "\n\n";
    }
    if (out.trim()) return out;
  }
  // fallback: whole files from source_file_ids (legacy courses)
  const ids: string[] = Array.isArray(topic.source_file_ids) ? topic.source_file_ids : [];
  if (ids.length === 0) return "";
  const { data: files } = await db.from("source_files").select("text_path").in("id", ids.slice(0, 5));
  for (const f of files ?? []) {
    if (!f.text_path || out.length >= MAX_MATERIAL_CHARS) continue;
    const dl = await db.storage.from(BUCKET).download(f.text_path);
    if (!dl.error && dl.data) out += (await dl.data.text()).slice(0, MAX_MATERIAL_CHARS - out.length) + "\n\n";
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

async function capstonePropose(args: any) {
  const { course_id, user_id } = args;
  const { data: course } = await db.from("courses").select("title").eq("id", course_id).single();
  const { data: profile } = await db.from("student_profile").select("motivation, semester_goal").eq("user_id", user_id).maybeSingle();
  const { data: topics } = await db.from("course_topics").select("title").eq("course_id", course_id).eq("level", 2).limit(60);
  const titles = (topics ?? []).map((t: any) => t.title);
  const prompt =
    `Propose 3 ambitious but achievable capstones a student could complete by the end of "${course?.title ?? "this course"}" that turn the learning into something REAL and shareable. ` +
    `Ground them in these course topics: ${JSON.stringify(titles.slice(0, 50))}. ` +
    `Tie them to what the student wants to be able to do: ${profile?.motivation ?? "—"} (goal: ${profile?.semester_goal ?? "—"}). ` +
    `Mix a paper and projects. Return ONLY JSON, no fences: {"candidates":[{"title":"","kind":"project|paper","summary":"1-2 sentences: what they build/write and why it's motivating"}]}`;
  const raw = await callClaude([{ type: "text", text: prompt }], 1200);
  let v: any = {}; try { v = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch (_) { v = {}; }
  const cands = Array.isArray(v?.candidates) ? v.candidates.slice(0, 3) : [];
  const rows = cands
    .filter((c: any) => c && typeof c.title === "string")
    .map((c: any) => ({
      user_id, course_id,
      title: String(c.title).slice(0, 200),
      kind: c.kind === "paper" ? "paper" : "project",
      summary: typeof c.summary === "string" ? c.summary.slice(0, 600) : null,
      status: "proposed",
    }));
  if (rows.length) {
    await db.from("capstones").delete().eq("course_id", course_id).eq("status", "proposed");
    await db.from("capstones").insert(rows);
  }
  await db.from("agent_actions").insert({ user_id, course_id, type: "capstone_propose", rationale: `${rows.length} proposed` });
}

async function capstonePlan(args: any) {
  const { capstone_id, user_id } = args;
  const { data: cap } = await db.from("capstones").select("*").eq("id", capstone_id).single();
  if (!cap) return;
  const { data: topics } = await db.from("course_topics").select("id, title").eq("course_id", cap.course_id).eq("level", 2);
  const byNorm = new Map((topics ?? []).map((t: any) => [norm(t.title), t.id]));
  const prompt =
    `Break this capstone into 4-6 ordered milestones aligned to the course, ending with making it real and shareable. ` +
    `Capstone: "${cap.title}" (${cap.kind}) — ${cap.summary ?? ""}. ` +
    `Course topics available: ${JSON.stringify((topics ?? []).map((t: any) => t.title).slice(0, 50))}. ` +
    `For each milestone give: title, detail (1-2 concrete sentences), and topics = the 1-3 course topic titles (FROM the list) that must be understood first. ` +
    `For the final "publish/share" milestone, use web search for concrete current venues/hosting/showcases and name real ones. Never invent a source. ` +
    `Return ONLY JSON, no fences: {"milestones":[{"title":"","detail":"","topics":[""]}]}`;
  const raw = await callClaude([{ type: "text", text: prompt }], 1500, [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
  let v: any = {}; try { v = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch (_) { v = {}; }
  const ms = Array.isArray(v?.milestones) ? v.milestones.slice(0, 8) : [];
  const rows = ms.filter((m: any) => m && typeof m.title === "string").map((m: any, i: number) => {
    const reqIds = (Array.isArray(m.topics) ? m.topics : [])
      .map((t: string) => byNorm.get(norm(String(t)))).filter(Boolean);
    return {
      user_id, capstone_id, order_index: i,
      title: String(m.title).slice(0, 200),
      detail: typeof m.detail === "string" ? m.detail.slice(0, 800) : null,
      required_topic_ids: reqIds,
    };
  });
  if (rows.length) {
    await db.from("capstone_milestones").delete().eq("capstone_id", capstone_id);
    await db.from("capstone_milestones").insert(rows);
    await db.from("capstones").update({ status: "active", updated_at: new Date().toISOString() }).eq("id", capstone_id);
  }
  await db.from("agent_actions").insert({ user_id, course_id: cap.course_id, type: "capstone_plan", rationale: `${rows.length} milestones` });
}

async function curriculum(args: any) {
  const { course_id, user_id, topic, goal } = args;
  const prompt =
    `A student wants to learn: "${topic}". Their goal: ${goal || "general mastery"}. ` +
    `Design a focused self-study curriculum as modules → topics, ordered for learning (foundations first). ` +
    `4-8 modules, each with 2-6 specific topics. Return ONLY JSON, no fences: {"modules":[{"title":"","topics":[""]}]}`;
  const raw = await callClaude([{ type: "text", text: prompt }], 1800);
  let v: any = {}; try { v = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch (_) { v = {}; }
  const modules = Array.isArray(v?.modules) ? v.modules.slice(0, 10) : [];
  let mi = 0;
  for (const m of modules) {
    if (!m || typeof m.title !== "string") continue;
    const { data: mod } = await db.from("course_topics")
      .insert({ course_id, parent_id: null, level: 1, order_index: mi, title: String(m.title).slice(0, 200), source_file_ids: [] })
      .select("id").single();
    mi++;
    if (!mod) continue;
    const ts = Array.isArray(m.topics) ? m.topics.slice(0, 8) : [];
    let ti = 0;
    const rows = ts.filter((t: any) => typeof t === "string" && t.trim()).map((t: string) => ({
      course_id, parent_id: mod.id, level: 2, order_index: ti++, title: t.slice(0, 200), source_file_ids: [],
    }));
    if (rows.length) await db.from("course_topics").insert(rows);
  }
  await db.from("courses").update({ status: "onboarded" }).eq("id", course_id);
  await db.from("agent_actions").insert({ user_id, course_id, type: "curriculum", rationale: `${mi} modules` });
}

async function coach(args: any) {
  const { mode } = args;
  if (mode === "capstone_propose") return capstonePropose(args);
  if (mode === "capstone_plan") return capstonePlan(args);
  if (mode === "curriculum") return curriculum(args);

  const { course_id, topic_id, user_id, question_id, answer } = args;
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
    } else if (mode === "check") {
      const { data: q } = question_id ? await db.from("questions").select("*").eq("id", question_id).single() : { data: null };
      const ans = String(answer ?? "").trim();
      if (!q) {
        body = "Couldn't find that question to check.";
      } else if (!ans) {
        body = "No answer was submitted.";
      } else {
        const hasSol = typeof q.solution_text === "string" && q.solution_text.trim().length > 0;
        let prompt: string;
        if (hasSol) {
          prompt =
            `You are assessing a university student's answer in ${courseTitle}, topic "${title}". You have the official solution from THEIR OWN course materials. Grade fairly and teach from it.\n\n` +
            `QUESTION:\n${q.question_text}\n\nOFFICIAL SOLUTION (from their materials):\n${q.solution_text}\n\nSTUDENT'S ANSWER:\n${ans}\n\n` +
            `Return ONLY JSON, no fences: {"verdict":"correct|partial|incorrect","score":0-100,"feedback":"2-4 sentences: name what they got right, then the SPECIFIC gap or misconception, then the one idea that fixes it. Do NOT restate the whole solution — reveal only what helps them see their own error. Encouraging, never harsh."}`;
        } else {
          const mt = await materialText(topic);
          prompt =
            `You are assessing a university student's answer in ${courseTitle}, topic "${title}". There is NO official solution in their materials, so assess using the course material below (if any) and careful reasoning, and be appropriately humble about it.\n\n` +
            (mt ? `COURSE MATERIAL:\n${mt}\n\n` : "") +
            `QUESTION:\n${q.question_text}\n\nSTUDENT'S ANSWER:\n${ans}\n\n` +
            `Return ONLY JSON, no fences: {"verdict":"correct|partial|incorrect","score":0-100,"feedback":"2-4 sentences. Make clear up front this is your assessment, not an official answer key. Name what's right, the specific gap, and the fix. Encouraging."}`;
        }
        const raw = await callClaude([{ type: "text", text: prompt }], 900);
        let v: any = {};
        try { v = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch (_) { v = {}; }
        const verdict = ["correct", "partial", "incorrect"].includes(v?.verdict) ? v.verdict : "partial";
        const score = Number.isFinite(v?.score) ? Math.max(0, Math.min(100, Math.round(v.score))) : null;
        const feedback = typeof v?.feedback === "string" && v.feedback.trim() ? v.feedback.trim() : raw.slice(0, 800);

        meta.question_id = q.id;
        meta.verdict = verdict;
        meta.score = score;
        meta.graded_on = hasSol ? "official_solution" : "materials_only";
        body = feedback;

        // An attempt is strong, evidence-based signal — let it move the student model.
        const understanding = verdict === "correct" ? "solid" : verdict === "partial" ? "developing" : "shaky";
        const now = new Date().toISOString();
        const { data: prev } = await db.from("student_mastery").select("attempts").eq("user_id", user_id).eq("topic_id", topic_id).maybeSingle();
        await db.from("student_mastery").upsert({
          user_id, course_id, topic_id,
          understanding_state: understanding,
          attempts: ((prev?.attempts ?? 0) as number) + 1,
          last_score: score,
          last_touched: now,
        }, { onConflict: "user_id,topic_id" });
        await db.from("study_log").insert({ user_id, course_id, topic_id, kind: "practiced" });
        await db.from("student_profile").update({ last_active_at: now }).eq("user_id", user_id);
        await db.from("question_attempts").insert({ user_id, course_id, topic_id, question_id: q.id, answer: ans.slice(0, 4000), verdict, score, graded_on: meta.graded_on });

        // Phase 6 checkpoint: when a concept becomes understood, generate its
        // real-world application note once (cached) — lands while it's fresh.
        if (understanding === "solid") {
          const { data: existingNote } = await db.from("application_notes").select("id").eq("user_id", user_id).eq("topic_id", topic_id).maybeSingle();
          if (!existingNote) fireApplication({ course_id, topic_id, user_id });
        }
      }
    } else if (mode === "application") {
      // Phase 6 — generate ONE cached, revisitable "why this matters" note.
      const { data: profile } = await db.from("student_profile").select("motivation, semester_goal").eq("user_id", user_id).maybeSingle();
      const { data: myCourses } = await db.from("courses").select("id, title").eq("user_id", user_id).eq("status", "onboarded");
      let spineCtx = "";
      for (const c of (myCourses ?? [])) {
        if (c.id === course_id) continue;
        const { data: ts } = await db.from("course_topics").select("title").eq("course_id", c.id).eq("level", 2).limit(40);
        if (ts && ts.length) spineCtx += `\n- ${c.title}: ${ts.map((t: any) => t.title).join("; ")}`;
      }
      const validCourses = new Set((myCourses ?? []).map((c: any) => c.title));

      const prompt =
        `Help a university student see why "${title}" (in ${courseTitle}) matters in the real world, to dissolve the feeling that it is abstract. This is for MOTIVATION, sized to inspire — not a content dump.\n` +
        `What the student wants to be able to do: ${profile?.motivation ?? "—"}. Their goal: ${profile?.semester_goal ?? "—"}.\n\n` +
        `Their OTHER onboarded courses and topics (use ONLY for finding GENUINE cross-course links — never force one):${spineCtx || " (none yet)"}\n\n` +
        `Use web search to find CONCRETE, current real-world uses (industry, research labs, real products, builder communities). Cite real sources you actually find — paraphrase them, never reproduce text, and never invent a source or a link.\n\n` +
        `Return ONLY JSON, no fences:\n` +
        `{"why":"2-4 sentences: where this matters and what it builds toward, connected to what the student wants to be able to do","uses":["3-5 short, concrete real-world uses"],"sources":[{"title":"page title","url":"real url you found"}],"cross_links":[{"course":"EXACT other course title from the list above","topic":"a topic from that course","link":"one sentence on the genuine connection"}],"depth":["optional 1-2 go-deeper pointers"]}`;

      const raw = await callClaude([{ type: "text", text: prompt }], 1500, [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }]);
      let v: any = {};
      try { v = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch (_) { v = {}; }

      const why = typeof v?.why === "string" ? v.why.trim().slice(0, 1500) : "";
      const uses = Array.isArray(v?.uses) ? v.uses.filter((x: any) => typeof x === "string").map((x: string) => x.slice(0, 300)).slice(0, 6) : [];
      const sources = Array.isArray(v?.sources)
        ? v.sources.filter((s: any) => s && typeof s.url === "string" && /^https?:\/\//.test(s.url))
            .map((s: any) => ({ title: String(s.title ?? s.url).slice(0, 200), url: String(s.url).slice(0, 600) })).slice(0, 6)
        : [];
      const cross = Array.isArray(v?.cross_links)
        ? v.cross_links.filter((l: any) => l && typeof l.link === "string" && validCourses.has(String(l.course)))
            .map((l: any) => ({ course: String(l.course).slice(0, 200), topic: String(l.topic ?? "").slice(0, 200), link: String(l.link).slice(0, 300) })).slice(0, 5)
        : [];
      const depth = Array.isArray(v?.depth) ? v.depth.filter((x: any) => typeof x === "string").map((x: string) => x.slice(0, 300)).slice(0, 3) : [];

      if (why || uses.length) {
        await db.from("application_notes").upsert(
          { user_id, course_id, topic_id, why, uses, sources, cross_links: cross, depth, updated_at: new Date().toISOString() },
          { onConflict: "user_id,topic_id" },
        );
        await db.from("agent_actions").insert({ user_id, course_id, type: "application", rationale: title });
      }
      return; // application writes its own row; skip the coaching insert below
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
  const topicModes = ["explain", "practice", "hook", "check", "application"];
  const ok =
    body.mode && body.user_id && (
      (topicModes.includes(body.mode) && body.course_id && body.topic_id) ||
      (body.mode === "capstone_propose" && body.course_id) ||
      (body.mode === "capstone_plan" && body.capstone_id) ||
      (body.mode === "curriculum" && body.course_id && body.topic)
    );
  if (ok) await coach(body);
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
