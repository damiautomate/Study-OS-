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

const WORKER_VERSION = "v7-pages";

const OCR_PROMPT =
  "Transcribe all readable text from this document verbatim, preserving reading order. " +
  "Include text from tables, figures, and handwriting where legible. " +
  "Before each page's content, output a line containing exactly [[PAGE k]] using the page's real number in the whole document; " +
  "the first page of this excerpt is page {FIRST_PAGE}. Output ONLY the markers and transcribed text, no commentary.";

const CATEGORIES = ["slides", "textbook", "notes", "assignment", "test", "exam", "solutions", "outline", "other"];
const understandInstruction = (courseTitle: string) =>
  `You are cataloguing one document from the university course "${courseTitle}". The text contains [[PAGE n]] markers showing page numbers. Based ONLY on the text below, return a single JSON object and nothing else — no markdown fences, no explanation. ` +
  'Keys: "category" (exactly one of: slides, textbook, notes, assignment, test, exam, solutions, outline, other), ' +
  '"category_confidence" (number 0 to 1), ' +
  '"summary" (2-3 sentences describing the document in plain language), ' +
  '"contains_questions" (true if it poses questions or problems to solve), ' +
  '"chapters" (ONLY if this is a textbook or book: array of {"title","pages":"firstPage-lastPage","relevant":true|false} for every chapter you can identify — from a table of contents if present — judging "relevant" against THIS course; otherwise omit or []), ' +
  '"topics" (array of {"title": short concept name, "pages": "n-m" page range where it is covered, from the [[PAGE n]] markers}). ' +
  "If this is a textbook, give topics ONLY from the chapters relevant to this course — ignore unrelated chapters. Text follows:\n\n";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---------- helpers ----------
async function logEvent(runId: string, kind: string, message: string, data?: unknown) {
  await db.from("run_events").insert({ run_id: runId, kind, message, data: data ?? null });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const d = await crypto.subtle.digest("SHA-256", ab);
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

// Drives the phase machine.
//   initial: read/understand → spine → questions(all docs) → coverage → review
//   augment: read/understand → assign(merge into existing spine) → questions(new docs only) → coverage → done (course stays onboarded)
async function maybeFinalize(runId: string, courseId: string) {
  const { count } = await db.from("onboarding_jobs").select("id", { count: "exact", head: true })
    .eq("run_id", runId).in("status", ["queued", "processing"]);
  if ((count ?? 0) > 0) return;

  const { data: run } = await db.from("onboarding_runs").select("stage, kind").eq("id", runId).single();
  const stage = run?.stage as string | undefined;
  const isAugment = run?.kind === "augment";
  if (!stage || stage === "done") return;

  // (1) reading/understanding done -> build the spine (initial) or merge (augment)
  if (stage !== "spine" && stage !== "assign" && stage !== "questions" && stage !== "coverage") {
    const next = isAugment ? "assign" : "spine";
    const { data: won } = await db.from("onboarding_runs")
      .update({ stage: next, updated_at: new Date().toISOString() })
      .eq("id", runId).eq("stage", stage).select("id");
    if (won && won.length > 0) {
      await db.from("onboarding_jobs").insert({ run_id: runId, stage: next });
      await logEvent(runId, "stage", isAugment ? "Merging into your course map…" : "Building the topic map…");
    }
    return;
  }

  // (2) spine/assign done -> extract questions
  if (stage === "spine" || stage === "assign") {
    const { data: won } = await db.from("onboarding_runs")
      .update({ stage: "questions", updated_at: new Date().toISOString() })
      .eq("id", runId).eq("stage", stage).select("id");
    if (won && won.length > 0) {
      let q = db.from("source_files")
        .select("id").eq("course_id", courseId).in("read_status", ["read", "partial"]).eq("contains_questions", true);
      if (isAugment) q = q.eq("run_id", runId); // only the NEW documents
      const { data: qdocs } = await q;
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

  // (4) coverage done -> review (initial) or quiet finish (augment)
  if (stage === "coverage") {
    if (isAugment) await finishAugment(runId, courseId);
    else await finishRun(runId, courseId);
  }
}

// Augment finish: run done, course STAYS onboarded; seed mastery for any new topics.
async function finishAugment(runId: string, courseId: string) {
  await db.from("onboarding_runs").update({ stage: "done", status: "done", updated_at: new Date().toISOString() }).eq("id", runId);
  const { data: course } = await db.from("courses").select("user_id").eq("id", courseId).single();
  if (course) {
    const { data: tps } = await db.from("course_topics").select("id").eq("course_id", courseId).eq("level", 2);
    const { data: have } = await db.from("student_mastery").select("topic_id").eq("course_id", courseId).eq("user_id", course.user_id);
    const haveSet = new Set((have ?? []).map((m: any) => m.topic_id));
    const missing = (tps ?? []).filter((t: any) => !haveSet.has(t.id))
      .map((t: any) => ({ user_id: course.user_id, course_id: courseId, topic_id: t.id }));
    if (missing.length) await db.from("student_mastery").upsert(missing, { onConflict: "user_id,topic_id", ignoreDuplicates: true });
  }
  await logEvent(runId, "stage", "New materials merged into your course ✓");
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
  await logEvent(runId, "stage", `Opening your upload… (worker ${WORKER_VERSION})`);

  // sources: legacy single zip_path, and/or a list of directly-uploaded files
  const sources: { path: string; name: string }[] = [];
  if (run.zip_path) sources.push({ path: run.zip_path, name: String(run.zip_path).split("/").pop() ?? "upload.zip" });
  if (Array.isArray(run.upload_paths)) {
    for (const u of run.upload_paths) if (u && typeof u.path === "string") sources.push({ path: u.path, name: typeof u.name === "string" ? u.name : u.path.split("/").pop() });
  }
  if (sources.length === 0) throw new Error("nothing to extract");

  // dedupe across the WHOLE course (so augment skips files already onboarded)
  const seen = new Map<string, string>();
  const { data: priorFiles } = await db.from("source_files").select("content_hash, original_path").eq("course_id", run.course_id);
  for (const pf of priorFiles ?? []) if (pf.content_hash) seen.set(pf.content_hash, pf.original_path);

  let idx = 0, dupes = 0, registered = 0;
  const readJobs: any[] = [];

  async function registerFile(originalName: string, bytes: Uint8Array, existingPath: string | null) {
    idx++;
    const hash = await sha256(bytes);
    const mime = detectMime(originalName, bytes);
    const isDup = seen.has(hash);
    let storagePath: string | null = existingPath;
    if (!isDup) {
      seen.set(hash, originalName);
      if (!existingPath) {
        const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
        storagePath = `extracted/${runId}/${idx}-${safeName}`;
        const up = await db.storage.from(BUCKET).upload(storagePath, bytes, { contentType: mime, upsert: true });
        if (up.error) throw new Error(`store failed for ${originalName}: ${up.error.message}`);
      }
    } else { dupes++; storagePath = null; }

    const { data: inserted, error: insErr } = await db.from("source_files").insert({
      course_id: run.course_id, run_id: runId, original_path: originalName,
      storage_path: storagePath, content_hash: hash, mime_type: mime,
      size_bytes: bytes.length,
      read_status: isDup ? "duplicate" : "pending",
      note: isDup ? `duplicate of ${seen.get(hash)}` : null,
    }).select("id").single();
    if (insErr) throw new Error(`db insert failed: ${insErr.message}`);
    if (!isDup) { readJobs.push({ run_id: runId, stage: "read", file_id: inserted!.id }); registered++; }
  }

  let totalBytes = 0;
  for (const src of sources) {
    const dl = await db.storage.from(BUCKET).download(src.path);
    if (dl.error || !dl.data) throw new Error(`could not download ${src.name}: ${dl.error?.message}`);
    const isZip = /\.zip$/i.test(src.name) || /\.zip$/i.test(src.path);

    if (isZip) {
      const zipReader = new ZipReader(new BlobReader(dl.data));
      const entries = await zipReader.getEntries();
      const files = entries.filter((e: any) => !e.directory && !isJunk(e.filename));
      if (files.length > MAX_FILES) { await zipReader.close(); throw new Error(`too many files in ${src.name} (${files.length} > ${MAX_FILES})`); }
      const totalUncompressed = files.reduce((s: number, e: any) => s + (e.uncompressedSize ?? 0), 0);
      totalBytes += totalUncompressed;
      if (totalBytes > MAX_TOTAL_UNCOMPRESSED) { await zipReader.close(); throw new Error("upload too large once unzipped"); }
      await logEvent(runId, "info", `Unzipped ${src.name} — ${files.length} files found`);
      for (const entry of files) {
        const bytes: Uint8Array = await entry.getData!(new Uint8ArrayWriter());
        await registerFile(entry.filename, bytes, null);
      }
      await zipReader.close();
    } else {
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_UNCOMPRESSED) throw new Error("upload too large");
      // direct upload already sits in storage — reuse its path, no copy
      await registerFile(src.name, bytes, src.path);
    }
    if (idx > MAX_FILES) throw new Error(`too many files (${idx} > ${MAX_FILES})`);
  }

  if (registered === 0 && dupes > 0) {
    await logEvent(runId, "info", "Everything you added was already in this course — nothing new to process");
  } else if (registered === 0) {
    throw new Error("no readable files found in the upload");
  }

  if (dupes > 0) await logEvent(runId, "info", `${dupes} duplicate ${dupes === 1 ? "file" : "files"} skipped`);
  if (readJobs.length > 0) await db.from("onboarding_jobs").insert(readJobs);
  await db.from("onboarding_runs").update({ stage: "read", updated_at: new Date().toISOString() }).eq("id", runId);
  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  if (readJobs.length > 0) await logEvent(runId, "stage", `Reading ${readJobs.length} files…`);
  else await maybeFinalize(runId, run.course_id);
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
      const result = await extractText(pdf, { mergePages: false });
      const pages: string[] = Array.isArray(result?.text) ? result.text : [String(result?.text ?? "")];
      const text = pages.map((pg: string, i: number) => `[[PAGE ${i + 1}]]\n${(pg ?? "").trim()}`).join("\n\n").trim();
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
        { type: "text", text: OCR_PROMPT.replace("{FIRST_PAGE}", "1") },
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
      { type: "text", text: OCR_PROMPT.replace("{FIRST_PAGE}", String(start + 1)) },
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
  const pagesOk = (x: any) => (typeof x === "string" && /^[0-9][0-9,\- ]*$/.test(x.trim()) ? x.trim().slice(0, 40) : null);
  const topics = Array.isArray(o?.topics)
    ? o.topics.map((t: any) => ({ title: typeof t === "string" ? t : (t?.title ?? ""), pages: pagesOk(t?.pages) })).filter((t: any) => t.title).slice(0, 40)
    : [];
  const chapters = Array.isArray(o?.chapters)
    ? o.chapters.map((c: any) => ({ title: String(c?.title ?? "").slice(0, 200), pages: pagesOk(c?.pages), relevant: !!c?.relevant }))
        .filter((c: any) => c.title).slice(0, 60)
    : [];
  return { category, category_confidence: conf, summary, contains_questions, topics, chapters };
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
      const { data: crs } = await db.from("courses").select("title").eq("id", file.course_id).single();
      const { text: out, usage } = await callClaude(
        UNDERSTAND_MODEL,
        [{ type: "text", text: understandInstruction(crs?.title ?? "this course") + text }],
        UNDERSTAND_MAX_TOKENS,
      );
      await db.from("ai_usage").insert({ run_id: runId, file_id: file.id, stage: "understand", model: UNDERSTAND_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
      parsed = parseUnderstanding(out);
    }

    if (parsed) { result = normalizeUnderstanding(parsed); succeeded = true; }
    else { result = { category: "other", category_confidence: 0, summary: "Could not classify automatically.", contains_questions: false, topics: [], chapters: [] }; }
  } catch (e) {
    result = { category: "other", category_confidence: 0, summary: `Classification error: ${(e as Error).message}`.slice(0, 200), contains_questions: false, topics: [], chapters: [] };
  }

  const relevantChapters = (result as any).chapters?.filter((c: any) => c.relevant) ?? [];
  const focusNote = relevantChapters.length
    ? `using: ${relevantChapters.map((c: any) => c.title + (c.pages ? ` (p.${c.pages})` : "")).join("; ").slice(0, 280)}`
    : null;
  await db.from("source_files").update({
    page_map: (result as any).chapters?.length ? (result as any).chapters : null,
    note: focusNote ?? undefined,
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

  // deterministic topic-title -> source-file mapping (no hallucinated ids), now with pages
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const fileTopics = docs.map((d: any) => ({
    id: d.id,
    entries: (d.topics || []).map((t: any) => ({ n: norm(t.title), pages: t?.pages ?? null })),
  }));
  const refsFor = (title: string) => {
    const n = norm(title);
    const out: { file_id: string; pages: string | null }[] = [];
    for (const ft of fileTopics) {
      const hits = ft.entries.filter((e: any) => e.n === n || e.n.includes(n) || n.includes(e.n));
      if (hits.length) out.push({ file_id: ft.id, pages: hits.find((h: any) => h.pages)?.pages ?? null });
    }
    return out;
  };
  const filesFor = (title: string) => refsFor(title).map((r) => r.file_id);
  const { data: courseRow } = await db.from("courses").select("user_id").eq("id", courseId).single();
  const ownerId = courseRow?.user_id;

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
      const refs = refsFor(title);
      const { data: tRow } = await db.from("course_topics").insert({
        course_id: courseId, parent_id: parent!.id, level: 2, order_index: ti++,
        title: String(title).slice(0, 200), source_file_ids: refs.map((r) => r.file_id),
      }).select("id").single();
      if (tRow && ownerId && refs.length) {
        await db.from("material_refs").upsert(
          refs.map((r) => ({ user_id: ownerId, course_id: courseId, topic_id: tRow.id, file_id: r.file_id, pages: r.pages })),
          { onConflict: "topic_id,file_id", ignoreDuplicates: true },
        );
      }
      count++;
    }
  }

  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  await logEvent(runId, count > 0 ? "success" : "warning", count > 0 ? `Topic map built — ${count} topics` : "Could not build the topic map automatically");
  await maybeFinalize(runId, courseId);
}

// ---------- stage: assign (augment runs: merge new files into the EXISTING spine) ----------
async function doAssign(job: any) {
  const runId = job.run_id;
  const { data: run } = await db.from("onboarding_runs").select("course_id").eq("id", runId).single();
  if (!run) throw new Error("run not found");
  const courseId = run.course_id;

  // the NEW files from this run that were read + understood
  const { data: newFiles } = await db.from("source_files")
    .select("id, original_path, category, summary, topics")
    .eq("run_id", runId).in("read_status", ["read", "partial"]);
  // the EXISTING spine
  const { data: spine } = await db.from("course_topics").select("id, parent_id, level, order_index, title").eq("course_id", courseId);
  const modules = (spine ?? []).filter((t: any) => t.level === 1);
  const topics = (spine ?? []).filter((t: any) => t.level === 2);

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const topicByNorm = new Map(topics.map((t: any) => [norm(t.title), t]));
  const moduleByNorm = new Map(modules.map((m: any) => [norm(m.title), m]));

  if (!newFiles || newFiles.length === 0) {
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "info", "No new readable files to merge");
    await maybeFinalize(runId, courseId);
    return;
  }
  if (topics.length === 0) {
    // no spine to merge into (shouldn't happen for onboarded courses) — leave files in inventory
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "warning", "Course has no topic map; files kept in inventory");
    await maybeFinalize(runId, courseId);
    return;
  }

  const fileLines = newFiles.map((f: any, i: number) =>
    `${i + 1}. "${f.original_path}" [${f.category ?? "unknown"}] — ${String(f.summary ?? "").slice(0, 220)} — covers: ${(f.topics || []).map((t: any) => t.title).join("; ").slice(0, 260)}`).join("\n");

  const prompt =
    "A student added NEW materials to an existing university course. Map each new file onto the EXISTING course map. " +
    "Use EXACT titles from the lists. Only propose a new topic when the file clearly covers something missing from the map; attach it under the best existing module.\n\n" +
    `EXISTING MODULES: ${JSON.stringify(modules.map((m: any) => m.title))}\n` +
    `EXISTING TOPICS: ${JSON.stringify(topics.map((t: any) => t.title))}\n\n` +
    `NEW FILES:\n${fileLines}\n\n` +
    'Return ONLY JSON, no fences: {"files":[{"file":"exact file name from the list","topics":["existing topic title", "..."],"new_topics":[{"module":"existing module title","title":"new topic title"}]}]}';

  let parsed: any = {};
  try {
    const { text, usage } = await callClaude(SPINE_MODEL, [{ type: "text", text: prompt }], 3000);
    await db.from("ai_usage").insert({ run_id: runId, file_id: null, stage: "spine", model: SPINE_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
    parsed = parseUnderstanding(text);
  } catch (_) { parsed = {}; }

  const fileByName = new Map(newFiles.map((f: any) => [norm(f.original_path), f]));
  const { data: courseRow } = await db.from("courses").select("user_id").eq("id", courseId).single();
  const ownerId = courseRow?.user_id;
  const pagesFor = (f: any, topicTitle: string) => {
    const n = norm(topicTitle);
    const hit = (f.topics || []).find((t: any) => { const tn = norm(t.title); return tn === n || tn.includes(n) || n.includes(tn); });
    return hit?.pages ?? null;
  };
  const refRows: any[] = [];
  const appendTo = new Map<string, Set<string>>(); // topic_id -> file ids to append
  let newTopicCount = 0, mappedFiles = 0;

  for (const row of (Array.isArray(parsed?.files) ? parsed.files : [])) {
    const f = fileByName.get(norm(String(row?.file ?? "")));
    if (!f) continue;
    let mapped = false;
    for (const tt of (Array.isArray(row?.topics) ? row.topics : [])) {
      const t = topicByNorm.get(norm(String(tt)));
      if (!t) continue;
      const set = appendTo.get(t.id) ?? new Set<string>();
      set.add(f.id); appendTo.set(t.id, set); mapped = true;
      if (ownerId) refRows.push({ user_id: ownerId, course_id: courseId, topic_id: t.id, file_id: f.id, pages: pagesFor(f, t.title) });
    }
    for (const nt of (Array.isArray(row?.new_topics) ? row.new_topics : []).slice(0, 2)) {
      const mod = moduleByNorm.get(norm(String(nt?.module ?? "")));
      const title = String(nt?.title ?? "").trim();
      if (!mod || !title || topicByNorm.has(norm(title))) continue;
      const maxOrder = Math.max(0, ...topics.filter((t: any) => t.parent_id === mod.id).map((t: any) => t.order_index ?? 0));
      const { data: created } = await db.from("course_topics").insert({
        course_id: courseId, parent_id: mod.id, level: 2, order_index: maxOrder + 1,
        title: title.slice(0, 200), source_file_ids: [f.id],
      }).select("id, parent_id, order_index, title").single();
      if (created) {
        topics.push({ ...created, level: 2 }); topicByNorm.set(norm(title), created); newTopicCount++; mapped = true;
        if (ownerId) refRows.push({ user_id: ownerId, course_id: courseId, topic_id: created.id, file_id: f.id, pages: pagesFor(f, title) });
      }
    }
    if (mapped) mappedFiles++;
  }

  // deterministic safety net: any unmapped file still gets title-matched onto topics
  for (const f of newFiles) {
    const already = [...appendTo.values()].some((set) => set.has(f.id));
    const inNew = topics.some((t: any) => Array.isArray((t as any).source_file_ids) && (t as any).source_file_ids?.includes?.(f.id));
    if (already || inNew) continue;
    const covered = (f.topics || []).map((t: any) => norm(t.title));
    for (const t of topics) {
      const n = norm(t.title);
      if (covered.some((c: string) => c === n || c.includes(n) || n.includes(c))) {
        const set = appendTo.get(t.id) ?? new Set<string>();
        set.add(f.id); appendTo.set(t.id, set);
        if (ownerId) refRows.push({ user_id: ownerId, course_id: courseId, topic_id: t.id, file_id: f.id, pages: pagesFor(f, t.title) });
      }
    }
  }

  // apply the appends (read-modify-write per topic, deduped)
  for (const [topicId, ids] of appendTo) {
    const { data: t } = await db.from("course_topics").select("source_file_ids").eq("id", topicId).single();
    const cur: string[] = Array.isArray(t?.source_file_ids) ? t.source_file_ids : [];
    const next = [...new Set([...cur, ...ids])];
    if (next.length !== cur.length) await db.from("course_topics").update({ source_file_ids: next }).eq("id", topicId);
  }

  if (refRows.length) {
    const seenRef = new Set<string>();
    const unique = refRows.filter((r) => { const k = r.topic_id + ":" + r.file_id; if (seenRef.has(k)) return false; seenRef.add(k); return true; });
    await db.from("material_refs").upsert(unique, { onConflict: "topic_id,file_id", ignoreDuplicates: true });
  }
  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  await logEvent(runId, "success", `Merged ${mappedFiles}/${newFiles.length} files into the map${newTopicCount ? ` · ${newTopicCount} new topic${newTopicCount === 1 ? "" : "s"}` : ""}`);
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
    else if (job.stage === "assign") await doAssign(job);
    else if (job.stage === "questions") await doQuestions(job);
    else if (job.stage === "coverage") await doCoverage(job);
    else await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  } catch (e) {
    await failJobAndRun(job, job.run_id, (e as Error).message);
  }
  return { worked: true };
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, worker: WORKER_VERSION }), { headers: { "Content-Type": "application/json" } });
  }
  if (req.headers.get("x-worker-secret") !== WORKER_SECRET) return new Response("forbidden", { status: 403 });
  const { worked } = await tick();
  if (worked) fireNextTick();
  return new Response(JSON.stringify({ worked }), { headers: { "Content-Type": "application/json" } });
});
