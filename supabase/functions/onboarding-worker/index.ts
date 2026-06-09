// =============================================================
// Study OS · onboarding-worker  (Supabase Edge Function, Deno)
//
// Stages:  extract -> read -> ocr -> understand -> done
//   extract    : unzip, hash, type, dedupe, store, queue reads
//   read       : one file — native text, or hand image files to OCR
//   ocr        : one file/chunk — transcribe via Claude vision
//   understand : one doc — classify + summarise + list topics (JSON)
//
// One bounded unit per invocation, then self-invokes to chain.
// =============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { ZipReader, BlobReader, Uint8ArrayWriter } from "npm:@zip.js/zip.js@2.7.45";
import { getDocumentProxy, extractText } from "npm:unpdf@0.12.1";
import { PDFDocument } from "npm:pdf-lib@1.17.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("WORKER_SECRET")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const OCR_MODEL = Deno.env.get("OCR_MODEL") ?? "claude-haiku-4-5-20251001";
const UNDERSTAND_MODEL = Deno.env.get("UNDERSTAND_MODEL") ?? "claude-haiku-4-5-20251001";
const SPINE_MODEL = Deno.env.get("SPINE_MODEL") ?? "claude-haiku-4-5-20251001";
const QUESTIONS_MODEL = Deno.env.get("QUESTIONS_MODEL") ?? "claude-haiku-4-5-20251001";
const BUCKET = "course-uploads";

const MAX_FILES = 500;
const MAX_TOTAL_UNCOMPRESSED = 300 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
const OCR_CHUNK_PAGES = Number(Deno.env.get("OCR_CHUNK_PAGES") ?? "8");
const MAX_OCR_PAGES = Number(Deno.env.get("MAX_OCR_PAGES") ?? "200");
const OCR_MAX_TOKENS = 16000;
const UNDERSTAND_MAX_TOKENS = 2000;
const MAX_UNDERSTAND_CHARS = Number(Deno.env.get("MAX_UNDERSTAND_CHARS") ?? "30000");

const OCR_PROMPT =
  "Transcribe all readable text from this document verbatim, preserving reading order. " +
  "Include text from tables, figures, and handwriting where legible. Output ONLY the transcribed text, no commentary.";

const CATEGORIES = ["slides", "textbook", "notes", "assignment", "test", "exam", "solutions", "outline", "other"];
const UNDERSTAND_INSTRUCTION =
  "You are cataloguing one document from a university course. Based ONLY on the text below, return a single JSON object and nothing else — no markdown fences, no explanation. " +
  'Keys: "category" (exactly one of: slides, textbook, notes, assignment, test, exam, solutions, outline, other), ' +
  '"category_confidence" (number 0 to 1), ' +
  '"summary" (2-3 sentences describing the document in plain language), ' +
  '"contains_questions" (true if it poses questions or problems to solve), ' +
  '"topics" (array of short concept names the document covers). Text follows:\n\n';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---------- helpers ----------
async function logEvent(runId: string, kind: string, message: string, data?: unknown) {
  await db.from("run_events").insert({ run_id: runId, kind, message, data: data ?? null });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function detectMime(name: string, b: Uint8Array): string {
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    const l = name.toLowerCase();
    if (l.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (l.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return "application/zip";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  const l = name.toLowerCase();
  if (l.endsWith(".txt") || l.endsWith(".md")) return "text/plain";
  if (l.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

function isJunk(path: string): boolean {
  if (path.includes("..") || path.startsWith("/")) return true;
  const base = path.split("/").pop() ?? "";
  if (path.startsWith("__MACOSX/") || path.includes("/__MACOSX/")) return true;
  if (base.startsWith(".")) return true;
  return false;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function fireNextTick() {
  try {
    // @ts-ignore EdgeRuntime provided by Supabase
    EdgeRuntime.waitUntil(
      fetch(`${SUPABASE_URL}/functions/v1/onboarding-worker`, {
        method: "POST",
        headers: { "x-worker-secret": WORKER_SECRET, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => {}),
    );
  } catch (_) { /* no-op */ }
}

async function enqueueUnderstand(runId: string, fileId: string) {
  await db.from("onboarding_jobs").insert({ run_id: runId, stage: "understand", file_id: fileId });
}

async function finishRun(runId: string, courseId: string) {
  await db.from("onboarding_runs").update({ stage: "done", status: "done", updated_at: new Date().toISOString() }).eq("id", runId);
  await db.from("courses").update({ status: "review" }).eq("id", courseId);
  await logEvent(runId, "stage", "Ready for your review");
}

// Drives the phase machine: read/understand → spine → questions → coverage → done.
async function maybeFinalize(runId: string, courseId: string) {
  const { count } = await db.from("onboarding_jobs").select("id", { count: "exact", head: true })
    .eq("run_id", runId).in("status", ["queued", "processing"]);
  if ((count ?? 0) > 0) return;

  const { data: run } = await db.from("onboarding_runs").select("stage").eq("id", runId).single();
  const stage = run?.stage as string | undefined;
  if (!stage || stage === "done") return;

  // (1) reading/understanding done -> build the spine
  if (stage !== "spine" && stage !== "questions" && stage !== "coverage") {
    const { data: won } = await db.from("onboarding_runs")
      .update({ stage: "spine", updated_at: new Date().toISOString() })
      .eq("id", runId).eq("stage", stage).select("id");
    if (won && won.length > 0) {
      await db.from("onboarding_jobs").insert({ run_id: runId, stage: "spine" });
      await logEvent(runId, "stage", "Building the topic map…");
    }
    return;
  }

  // (2) spine done -> extract questions
  if (stage === "spine") {
    const { data: won } = await db.from("onboarding_runs")
      .update({ stage: "questions", updated_at: new Date().toISOString() })
      .eq("id", runId).eq("stage", "spine").select("id");
    if (won && won.length > 0) {
      const { data: qdocs } = await db.from("source_files")
        .select("id").eq("course_id", courseId).in("read_status", ["read", "partial"]).eq("contains_questions", true);
      if (qdocs && qdocs.length > 0) {
        await db.from("onboarding_jobs").insert(qdocs.map((d: any) => ({ run_id: runId, stage: "questions", file_id: d.id })));
        await logEvent(runId, "stage", `Finding past questions in ${qdocs.length} ${qdocs.length === 1 ? "document" : "documents"}…`);
      } else {
        await maybeFinalize(runId, courseId); // nothing to do; advance to coverage
      }
    }
    return;
  }

  // (3) questions done -> coverage report
  if (stage === "questions") {
    const { data: won } = await db.from("onboarding_runs")
      .update({ stage: "coverage", updated_at: new Date().toISOString() })
      .eq("id", runId).eq("stage", "questions").select("id");
    if (won && won.length > 0) {
      await db.from("onboarding_jobs").insert({ run_id: runId, stage: "coverage" });
      await logEvent(runId, "stage", "Checking coverage…");
    }
    return;
  }

  // (4) coverage done -> hand to review
  if (stage === "coverage") {
    await finishRun(runId, courseId);
  }
}

async function failJobAndRun(job: any, runId: string, msg: string) {
  if (job.attempts >= MAX_ATTEMPTS) {
    await db.from("onboarding_jobs").update({ status: "failed" }).eq("id", job.id);
    await db.from("onboarding_runs").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", runId);
    await logEvent(runId, "error", `Stopped: ${msg}`);
  } else {
    await db.from("onboarding_jobs").update({ status: "queued", locked_at: null }).eq("id", job.id);
    await logEvent(runId, "warning", `Retrying after error: ${msg}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callClaude(model: string, content: unknown[], maxTokens: number): Promise<{ text: string; usage: any }> {
  let lastErr = "call failed";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
      return { text, usage: data.usage ?? {} };
    }
    lastErr = `Claude ${res.status}: ${(await res.text()).slice(0, 160)}`;
    // 429 = rate limited, 529 = overloaded, 5xx = transient -> back off and retry
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
      const backoff = Math.min(45, Number.isFinite(ra) && ra > 0 ? ra : Math.pow(2, attempt) * 4);
      await sleep(backoff * 1000 + Math.floor(Math.random() * 800));
      continue;
    }
    throw new Error(lastErr); // non-retryable (bad request, auth, etc.)
  }
  throw new Error(lastErr);
}

// ---------- stage: extract ----------
async function doExtract(job: any) {
  const runId = job.run_id;
  const { data: run } = await db.from("onboarding_runs").select("*").eq("id", runId).single();
  if (!run) throw new Error("run not found");

  await db.from("onboarding_runs").update({ status: "running", stage: "extract", updated_at: new Date().toISOString() }).eq("id", runId);
  await logEvent(runId, "stage", "Opening your upload…");

  const dl = await db.storage.from(BUCKET).download(run.zip_path);
  if (dl.error || !dl.data) throw new Error(`could not download zip: ${dl.error?.message}`);

  const zipReader = new ZipReader(new BlobReader(dl.data));
  const entries = await zipReader.getEntries();
  const files = entries.filter((e: any) => !e.directory && !isJunk(e.filename));

  if (files.length === 0) { await zipReader.close(); throw new Error("no readable files found in the zip"); }
  if (files.length > MAX_FILES) { await zipReader.close(); throw new Error(`too many files (${files.length} > ${MAX_FILES})`); }
  const totalUncompressed = files.reduce((s: number, e: any) => s + (e.uncompressedSize ?? 0), 0);
  if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) { await zipReader.close(); throw new Error("upload too large once unzipped"); }

  await logEvent(runId, "info", `Unzipped — ${files.length} files found`);

  const seen = new Map<string, string>();
  let dupes = 0, idx = 0;
  const readJobs: any[] = [];

  for (const entry of files) {
    idx++;
    const bytes: Uint8Array = await entry.getData(new Uint8ArrayWriter());
    const hash = await sha256(bytes);
    const mime = detectMime(entry.filename, bytes);
    const safeName = entry.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
    const storagePath = `extracted/${runId}/${idx}-${safeName}`;

    const isDup = seen.has(hash);
    if (!isDup) {
      seen.set(hash, entry.filename);
      const up = await db.storage.from(BUCKET).upload(storagePath, bytes, { contentType: mime, upsert: true });
      if (up.error) throw new Error(`store failed for ${entry.filename}: ${up.error.message}`);
    } else dupes++;

    const { data: inserted, error: insErr } = await db.from("source_files").insert({
      course_id: run.course_id, run_id: runId, original_path: entry.filename,
      storage_path: isDup ? null : storagePath, content_hash: hash, mime_type: mime,
      size_bytes: entry.uncompressedSize ?? bytes.length,
      read_status: isDup ? "duplicate" : "pending",
      note: isDup ? `duplicate of ${seen.get(hash)}` : null,
    }).select("id").single();
    if (insErr) throw new Error(`db insert failed: ${insErr.message}`);
    if (!isDup) readJobs.push({ run_id: runId, stage: "read", file_id: inserted!.id });
  }
  await zipReader.close();

  if (dupes > 0) await logEvent(runId, "info", `${dupes} duplicate ${dupes === 1 ? "file" : "files"} skipped`);
  if (readJobs.length > 0) await db.from("onboarding_jobs").insert(readJobs);
  await db.from("onboarding_runs").update({ stage: "read", updated_at: new Date().toISOString() }).eq("id", runId);
  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  await logEvent(runId, "stage", `Reading ${readJobs.length} files…`);
}

// ---------- stage: read ----------
async function doRead(job: any) {
  const runId = job.run_id;
  const { data: file } = await db.from("source_files").select("*").eq("id", job.file_id).single();
  if (!file || file.read_status !== "pending") {
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    if (file) await maybeFinalize(runId, file.course_id);
    return;
  }

  let status = "unsupported";
  let pageCount: number | null = file.page_count;
  let textPath: string | null = null;
  let note: string | null = null;
  let queueOcr = false;

  try {
    const dl = await db.storage.from(BUCKET).download(file.storage_path);
    if (dl.error || !dl.data) throw new Error("file missing in storage");
    const bytes = new Uint8Array(await dl.data.arrayBuffer());

    if (file.mime_type === "application/pdf") {
      const pdf = await getDocumentProxy(bytes);
      pageCount = pdf.numPages;
      const result = await extractText(pdf, { mergePages: true });
      const text = (typeof result?.text === "string" ? result.text : "").trim();
      if (text.length >= Math.max(40, pageCount * 20)) {
        textPath = `text/${runId}/${file.id}.txt`;
        await db.storage.from(BUCKET).upload(textPath, new TextEncoder().encode(text), { contentType: "text/plain", upsert: true });
        status = "read";
      } else { status = "needs_ocr"; queueOcr = true; note = "scanned PDF — reading with OCR"; }
    } else if (file.mime_type?.startsWith("image/")) {
      status = "needs_ocr"; queueOcr = true; note = "image — reading with OCR";
    } else if (file.mime_type === "text/plain" || file.mime_type === "text/csv") {
      const text = new TextDecoder().decode(bytes);
      textPath = `text/${runId}/${file.id}.txt`;
      await db.storage.from(BUCKET).upload(textPath, new TextEncoder().encode(text), { contentType: "text/plain", upsert: true });
      status = "read";
    } else { status = "unsupported"; note = "office/other format — extraction in a later slice"; }
  } catch (e) {
    status = "failed"; note = `read error: ${(e as Error).message}`.slice(0, 300);
  }

  await db.from("source_files").update({ read_status: status, page_count: pageCount, text_path: textPath, note }).eq("id", file.id);
  if (queueOcr) await db.from("onboarding_jobs").insert({ run_id: runId, stage: "ocr", file_id: file.id, chunk_index: 0 });
  if (status === "read") await enqueueUnderstand(runId, file.id);
  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);

  const label = file.original_path.split("/").pop();
  if (status === "read") await logEvent(runId, "success", `Read: ${label}`);
  else if (!queueOcr) await logEvent(runId, "info", `Skipped (${status}): ${label}`);

  await maybeFinalize(runId, file.course_id);
}

// ---------- stage: ocr ----------
async function doOcr(job: any) {
  const runId = job.run_id;
  const { data: file } = await db.from("source_files").select("*").eq("id", job.file_id).single();
  if (!file || file.read_status !== "needs_ocr") {
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    if (file) await maybeFinalize(runId, file.course_id);
    return;
  }

  const label = file.original_path.split("/").pop();
  const textPath = `text/${runId}/${file.id}.txt`;

  try {
    const dl = await db.storage.from(BUCKET).download(file.storage_path);
    if (dl.error || !dl.data) throw new Error("file missing in storage");
    const bytes = new Uint8Array(await dl.data.arrayBuffer());

    if (file.mime_type?.startsWith("image/")) {
      const { text, usage } = await callClaude(OCR_MODEL, [
        { type: "image", source: { type: "base64", media_type: file.mime_type, data: toBase64(bytes) } },
        { type: "text", text: OCR_PROMPT },
      ], OCR_MAX_TOKENS);
      await db.storage.from(BUCKET).upload(textPath, new TextEncoder().encode(text), { contentType: "text/plain", upsert: true });
      await db.from("ai_usage").insert({ run_id: runId, file_id: file.id, stage: "ocr", model: OCR_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
      await db.from("source_files").update({ read_status: "read", text_path: textPath }).eq("id", file.id);
      await enqueueUnderstand(runId, file.id);
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      await logEvent(runId, "success", `Read (OCR): ${label}`);
      await maybeFinalize(runId, file.course_id);
      return;
    }

    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total = src.getPageCount();
    const cap = Math.min(total, MAX_OCR_PAGES);
    const idx = job.chunk_index ?? 0;
    const start = idx * OCR_CHUNK_PAGES;
    const end = Math.min(start + OCR_CHUNK_PAGES, cap);

    const out = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const copied = await out.copyPages(src, indices);
    copied.forEach((p) => out.addPage(p));
    const chunkBytes = await out.save();

    const { text, usage } = await callClaude(OCR_MODEL, [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(new Uint8Array(chunkBytes)) } },
      { type: "text", text: OCR_PROMPT },
    ], OCR_MAX_TOKENS);
    await db.from("ai_usage").insert({ run_id: runId, file_id: file.id, stage: "ocr", model: OCR_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });

    let prior = "";
    if (idx > 0) {
      const ex = await db.storage.from(BUCKET).download(textPath);
      if (!ex.error && ex.data) prior = await ex.data.text();
    }
    const merged = idx > 0 ? `${prior}\n\n${text}` : text;
    await db.storage.from(BUCKET).upload(textPath, new TextEncoder().encode(merged), { contentType: "text/plain", upsert: true });

    if (end >= cap) {
      const final = cap < total ? "partial" : "read";
      await db.from("source_files").update({
        read_status: final, page_count: total, text_path: textPath,
        note: cap < total ? `OCR limited to first ${cap} of ${total} pages` : null,
      }).eq("id", file.id);
      await enqueueUnderstand(runId, file.id);
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      await logEvent(runId, "success", `Read (OCR): ${label}${cap < total ? " (partial)" : ""}`);
      await maybeFinalize(runId, file.course_id);
    } else {
      await db.from("onboarding_jobs").insert({ run_id: runId, stage: "ocr", file_id: file.id, chunk_index: idx + 1 });
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      await logEvent(runId, "info", `Reading scanned pages ${start + 1}–${end} of ${cap}: ${label}`);
    }
  } catch (e) {
    await db.from("source_files").update({ read_status: "ocr_failed", note: `OCR error: ${(e as Error).message}`.slice(0, 300) }).eq("id", file.id);
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "warning", `Could not OCR: ${label}`);
    await maybeFinalize(runId, file.course_id);
  }
}

// ---------- stage: understand ----------
function parseUnderstanding(raw: string): any {
  let s = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* ignore */ } }
  return undefined;
}

function normalizeUnderstanding(o: any) {
  const category = CATEGORIES.includes(o?.category) ? o.category : "other";
  let conf = Number(o?.category_confidence);
  if (!(conf >= 0 && conf <= 1)) conf = 0.5;
  const summary = typeof o?.summary === "string" ? o.summary.slice(0, 600) : "";
  const contains_questions = !!o?.contains_questions;
  const topics = Array.isArray(o?.topics)
    ? o.topics.map((t: any) => ({ title: typeof t === "string" ? t : (t?.title ?? "") })).filter((t: any) => t.title).slice(0, 40)
    : [];
  return { category, category_confidence: conf, summary, contains_questions, topics };
}

async function doUnderstand(job: any) {
  const runId = job.run_id;
  const { data: file } = await db.from("source_files").select("*").eq("id", job.file_id).single();
  if (!file || file.category != null || !["read", "partial"].includes(file.read_status) || !file.text_path) {
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    if (file) await maybeFinalize(runId, file.course_id);
    return;
  }

  const label = file.original_path.split("/").pop();
  let result = normalizeUnderstanding(undefined); // fallback default
  let succeeded = false;

  try {
    const dl = await db.storage.from(BUCKET).download(file.text_path);
    if (dl.error || !dl.data) throw new Error("text missing");
    let text = await dl.data.text();
    if (text.length > MAX_UNDERSTAND_CHARS) text = text.slice(0, MAX_UNDERSTAND_CHARS);

    let parsed: any;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const { text: out, usage } = await callClaude(
        UNDERSTAND_MODEL,
        [{ type: "text", text: UNDERSTAND_INSTRUCTION + text }],
        UNDERSTAND_MAX_TOKENS,
      );
      await db.from("ai_usage").insert({ run_id: runId, file_id: file.id, stage: "understand", model: UNDERSTAND_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
      parsed = parseUnderstanding(out);
    }

    if (parsed) { result = normalizeUnderstanding(parsed); succeeded = true; }
    else { result = { category: "other", category_confidence: 0, summary: "Could not classify automatically.", contains_questions: false, topics: [] }; }
  } catch (e) {
    result = { category: "other", category_confidence: 0, summary: `Classification error: ${(e as Error).message}`.slice(0, 200), contains_questions: false, topics: [] };
  }

  await db.from("source_files").update({
    category: result.category,
    category_confidence: result.category_confidence,
    summary: result.summary,
    contains_questions: result.contains_questions,
    topics: result.topics,
  }).eq("id", file.id);
  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  await logEvent(runId, succeeded ? "success" : "warning", `Understood: ${label} → ${result.category}`);
  await maybeFinalize(runId, file.course_id);
}

// ---------- stage: spine (course-level, runs once) ----------
async function doSpine(job: any) {
  const runId = job.run_id;
  const { data: run } = await db.from("onboarding_runs").select("course_id").eq("id", runId).single();
  if (!run) { await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id); return; }
  const courseId = run.course_id;

  // idempotent: if a spine already exists, don't rebuild
  const { count: existing } = await db.from("course_topics").select("id", { count: "exact", head: true }).eq("course_id", courseId);
  if ((existing ?? 0) > 0) {
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await maybeFinalize(runId, courseId);
    return;
  }

  const { data: files } = await db.from("source_files")
    .select("id, original_path, category, topics")
    .eq("course_id", courseId).in("read_status", ["read", "partial"]);
  const docs = (files ?? []).filter((f: any) => Array.isArray(f.topics) && f.topics.length > 0);

  if (docs.length === 0) {
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "info", "No topics found to map");
    await maybeFinalize(runId, courseId);
    return;
  }

  const lines = docs.map((d: any) =>
    `- [${d.category}] ${d.original_path.split("/").pop()}: ${d.topics.map((t: any) => t.title).join("; ")}`
  ).join("\n");
  const prompt =
    "You are building the topic map (syllabus spine) for one university course, from the topics found across its materials. " +
    "Merge and de-duplicate them into ONE ordered, two-level outline reflecting how the course is most likely taught (foundational topics first). " +
    "If a course outline is present, prefer its structure. " +
    'Return ONLY JSON: {"modules":[{"title":"Module name","topics":["Topic","Topic"]}]} — no prose, no code fences.\n\nMaterials and their topics:\n\n' +
    lines;

  let parsed: any;
  try {
    const { text, usage } = await callClaude(SPINE_MODEL, [{ type: "text", text: prompt }], 4000);
    await db.from("ai_usage").insert({ run_id: runId, file_id: null, stage: "spine", model: SPINE_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
    parsed = parseUnderstanding(text);
  } catch (_) { /* fall through to empty */ }

  const modules = Array.isArray(parsed?.modules) ? parsed.modules : [];

  // deterministic topic-title -> source-file mapping (no hallucinated ids)
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const fileTopics = docs.map((d: any) => ({ id: d.id, titles: (d.topics || []).map((t: any) => norm(t.title)) }));
  const filesFor = (title: string) => {
    const n = norm(title);
    return fileTopics.filter((ft) => ft.titles.some((t) => t === n || t.includes(n) || n.includes(t))).map((ft) => ft.id);
  };

  let mi = 0, count = 0;
  for (const m of modules) {
    if (!m?.title) continue;
    const { data: parent } = await db.from("course_topics").insert({
      course_id: courseId, parent_id: null, level: 1, order_index: mi++, title: String(m.title).slice(0, 200),
    }).select("id").single();
    count++;
    const subs = Array.isArray(m.topics) ? m.topics : [];
    let ti = 0;
    for (const s of subs) {
      const title = typeof s === "string" ? s : (s?.title ?? "");
      if (!title) continue;
      await db.from("course_topics").insert({
        course_id: courseId, parent_id: parent!.id, level: 2, order_index: ti++,
        title: String(title).slice(0, 200), source_file_ids: filesFor(title),
      });
      count++;
    }
  }

  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  await logEvent(runId, count > 0 ? "success" : "warning", count > 0 ? `Topic map built — ${count} topics` : "Could not build the topic map automatically");
  await maybeFinalize(runId, courseId);
}

// ---------- stage: questions (one question-bearing document) ----------
const Q_TYPES = ["mcq", "short", "essay", "numerical", "proof", "other"];
const Q_DIFF = ["easy", "medium", "hard"];

async function doQuestions(job: any) {
  const runId = job.run_id;
  const { data: file } = await db.from("source_files").select("*").eq("id", job.file_id).single();
  if (!file || !file.text_path) {
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    if (file) await maybeFinalize(runId, file.course_id);
    return;
  }
  const courseId = file.course_id;
  const label = file.original_path.split("/").pop();

  // idempotent: skip if this file already produced questions
  const { count: already } = await db.from("questions").select("id", { count: "exact", head: true }).eq("source_file_id", file.id);
  if ((already ?? 0) > 0) {
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await maybeFinalize(runId, courseId);
    return;
  }

  try {
    const dl = await db.storage.from(BUCKET).download(file.text_path);
    if (dl.error || !dl.data) throw new Error("text missing");
    let text = await dl.data.text();
    if (text.length > MAX_UNDERSTAND_CHARS) text = text.slice(0, MAX_UNDERSTAND_CHARS);

    const { data: topicRows } = await db.from("course_topics").select("id, title").eq("course_id", courseId).eq("level", 2);
    const topics = (topicRows ?? []) as { id: string; title: string }[];
    const topicList = topics.map((t) => t.title);

    const prompt =
      "You are extracting practice questions from one document in a university course. " +
      "Identify each distinct question or problem posed to the student. " +
      'Return ONLY JSON: {"questions":[{"text":"the full question","type":"mcq|short|essay|numerical|proof|other","difficulty":"easy|medium|hard","topic":"best-matching topic from the list, or null","has_solution":true|false,"solution":"the full worked solution or final answer EXACTLY as shown in THIS document, or null"}]}. ' +
      "Set has_solution true only if the answer/solution is shown in THIS document, and when it is, put the actual solution text verbatim (including any working) in \"solution\". If no solution is shown, set has_solution false and solution null. Never invent a solution. " +
      "Choose topic ONLY from this list (or null if none fits): " + JSON.stringify(topicList) +
      ". If the document has no questions, return {\"questions\":[]}.\n\nDocument text:\n\n" + text;

    let parsed: any;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const { text: out, usage } = await callClaude(QUESTIONS_MODEL, [{ type: "text", text: prompt }], 8000);
      await db.from("ai_usage").insert({ run_id: runId, file_id: file.id, stage: "questions", model: QUESTIONS_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
      parsed = parseUnderstanding(out);
    }

    const list = Array.isArray(parsed?.questions) ? parsed.questions.slice(0, 200) : [];
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const topicByNorm = new Map(topics.map((t) => [norm(t.title), t.id]));

    const rows = [];
    for (const q of list) {
      const qtext = typeof q?.text === "string" ? q.text.trim() : "";
      if (!qtext) continue;
      let topicId: string | null = null;
      if (q?.topic && typeof q.topic === "string") {
        const n = norm(q.topic);
        topicId = topicByNorm.get(n) ?? null;
        if (!topicId) {
          for (const [tn, id] of topicByNorm) { if (tn.includes(n) || n.includes(tn)) { topicId = id; break; } }
        }
      }
      const solutionText = typeof q?.solution === "string" && q.solution.trim() ? q.solution.trim().slice(0, 6000) : null;
      rows.push({
        course_id: courseId,
        source_file_id: file.id,
        topic_id: topicId,
        question_text: qtext.slice(0, 4000),
        q_type: Q_TYPES.includes(q?.type) ? q.type : "other",
        difficulty: Q_DIFF.includes(q?.difficulty) ? q.difficulty : null,
        has_solution: !!(q?.has_solution || solutionText),
        solution_text: solutionText,
      });
    }

    if (rows.length > 0) await db.from("questions").insert(rows);
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "success", `Found ${rows.length} question${rows.length === 1 ? "" : "s"}: ${label}`);
  } catch (e) {
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "warning", `Could not extract questions: ${label}`);
  }
  await maybeFinalize(runId, courseId);
}

// ---------- stage: coverage (course-level, deterministic) ----------
async function doCoverage(job: any) {
  const runId = job.run_id;
  const { data: run } = await db.from("onboarding_runs").select("course_id").eq("id", runId).single();
  if (!run) { await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id); return; }
  const courseId = run.course_id;

  const { data: topics } = await db.from("course_topics").select("id, source_file_ids").eq("course_id", courseId).eq("level", 2);
  const { data: qs } = await db.from("questions").select("topic_id").eq("course_id", courseId);

  const qCount = new Map<string, number>();
  for (const q of qs ?? []) if (q.topic_id) qCount.set(q.topic_id, (qCount.get(q.topic_id) ?? 0) + 1);

  let noReading = 0, noQuestions = 0;
  for (const t of topics ?? []) {
    const sc = Array.isArray(t.source_file_ids) ? t.source_file_ids.length : 0;
    const qc = qCount.get(t.id) ?? 0;
    await db.from("course_topics").update({ source_count: sc, question_count: qc }).eq("id", t.id);
    if (sc === 0) noReading++;
    if (qc === 0) noQuestions++;
  }

  const { count: untagged } = await db.from("questions").select("id", { count: "exact", head: true }).eq("course_id", courseId).is("topic_id", null);
  const { count: unreadable } = await db.from("source_files").select("id", { count: "exact", head: true }).eq("course_id", courseId).in("read_status", ["failed", "ocr_failed", "unsupported"]);

  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  await logEvent(runId, "info",
    `Coverage — ${(topics ?? []).length} topics · ${noReading} without readings · ${noQuestions} without questions · ${untagged ?? 0} untagged questions · ${unreadable ?? 0} unreadable files`,
    { noReading, noQuestions, untagged, unreadable });
  await maybeFinalize(runId, courseId);
}

// ---------- main tick ----------
async function tick(): Promise<{ worked: boolean }> {
  const { data: job, error } = await db.rpc("claim_onboarding_job");
  if (error) { console.error("claim error", error); return { worked: false }; }
  if (!job) return { worked: false };

  try {
    if (job.stage === "extract") await doExtract(job);
    else if (job.stage === "read") await doRead(job);
    else if (job.stage === "ocr") await doOcr(job);
    else if (job.stage === "understand") await doUnderstand(job);
    else if (job.stage === "spine") await doSpine(job);
    else if (job.stage === "questions") await doQuestions(job);
    else if (job.stage === "coverage") await doCoverage(job);
    else await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  } catch (e) {
    await failJobAndRun(job, job.run_id, (e as Error).message);
  }
  return { worked: true };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-worker-secret") !== WORKER_SECRET) return new Response("forbidden", { status: 403 });
  const { worked } = await tick();
  if (worked) fireNextTick();
  return new Response(JSON.stringify({ worked }), { headers: { "Content-Type": "application/json" } });
});
