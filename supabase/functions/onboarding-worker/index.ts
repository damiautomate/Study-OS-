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
// Heavy libraries are lazy-loaded inside the stages that need them — keeping the
// baseline memory of every invocation small (Edge functions have tight limits).

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
const MAX_UNDERSTAND_CHARS = Number(Deno.env.get("MAX_UNDERSTAND_CHARS") ?? "20000");

const WORKER_VERSION = "v24-toc";
// Edge functions get ~2s CPU / 256MB — never load big files into memory.
const MAX_FILE_MB = Number(Deno.env.get("MAX_FILE_MB") ?? "25");
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const HASH_MAX_BYTES = Number(Deno.env.get("HASH_MAX_MB") ?? "20") * 1024 * 1024;

const OCR_PROMPT =
  "Transcribe ONLY pages {FIRST_PAGE} through {LAST_PAGE} of this document, verbatim, preserving reading order. Ignore all other pages completely. " +
  "Include text from tables, figures, and handwriting where legible. " +
  "Before each page's content, output a line containing exactly [[PAGE k]] where k is that page's real number in the whole document. " +
  "Output ONLY the markers and transcribed text, no commentary.";

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

// (self-invocation removed in Path C — the cron drives one batch-draining beat per
// minute; there is no code path that invokes the worker from itself.)


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

const CLAUDE_TIMEOUT_MS = Number(Deno.env.get("CLAUDE_TIMEOUT_MS") ?? "110000");

async function callClaude(model: string, content: unknown[], maxTokens: number): Promise<{ text: string; usage: any }> {
  let lastErr = "call failed";
  const MAX_ATTEMPTS = Number(Deno.env.get("CLAUDE_MAX_ATTEMPTS") ?? "6");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
        signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
      });
    } catch (e) {
      // timed out or network dropped — retry with backoff rather than hanging forever
      lastErr = `Claude call ${(e as Error).name === "TimeoutError" ? "timed out" : "failed"}: ${(e as Error).message}`.slice(0, 160);
      await sleep(Math.pow(2, attempt) * 3000 + Math.floor(Math.random() * 800));
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const text = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
      return { text, usage: data.usage ?? {} };
    }
    lastErr = `Claude ${res.status}: ${(await res.text()).slice(0, 160)}`;
    // 429 = rate limited, 529 = overloaded, 5xx = transient -> back off and retry
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      // honor server timing hints; for 429 the input-token window is per-MINUTE, so
      // wait long enough for it to actually refill instead of giving up.
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const resetHdr = res.headers.get("anthropic-ratelimit-input-tokens-reset");
      let waitS: number;
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitS = retryAfter;
      else if (resetHdr) waitS = Math.max(1, Math.ceil((new Date(resetHdr).getTime() - Date.now()) / 1000));
      else if (res.status === 429) waitS = 60; // assume a full per-minute window
      else waitS = Math.pow(2, attempt) * 4;
      waitS = Math.min(75, waitS) + 2; // cap so a single beat stays inside the ~400s budget
      await sleep(waitS * 1000 + Math.floor(Math.random() * 800));
      continue;
    }
    throw new Error(lastErr); // non-retryable (bad request, auth, etc.)
  }
  throw new Error(lastErr);
}

// ---------- stage: extract (v9: chunked + self-chaining, never loads big files) ----------
// Each invocation does a SMALL batch of work, then chains to the next — the only way
// to stay inside Edge CPU/memory limits on big uploads.
const EXTRACT_BATCH = Number(Deno.env.get("EXTRACT_BATCH") ?? "3");

// file size WITHOUT downloading (HEAD on a signed URL)
async function headSize(path: string): Promise<number | null> {
  try {
    const { data: su } = await db.storage.from(BUCKET).createSignedUrl(path, 60);
    if (!su?.signedUrl) return null;
    const res = await fetch(su.signedUrl, { method: "HEAD" });
    const len = Number(res.headers.get("content-length"));
    return Number.isFinite(len) && len > 0 ? len : null;
  } catch (_) { return null; }
}

async function doExtract(job: any) {
  const runId = job.run_id;
  const chunk = job.chunk_index ?? 0;
  const { data: run } = await db.from("onboarding_runs").select("*").eq("id", runId).single();
  if (!run) throw new Error("run not found");

  if (chunk === 0) {
    await db.from("onboarding_runs").update({ status: "running", stage: "extract", updated_at: new Date().toISOString() }).eq("id", runId);
    await logEvent(runId, "stage", `Opening your upload… (worker ${WORKER_VERSION})`);
  }

  // sources: legacy single zip_path, and/or directly-uploaded files
  const sources: { path: string; name: string; size?: number | null; mime?: string | null }[] = [];
  if (run.zip_path) sources.push({ path: run.zip_path, name: String(run.zip_path).split("/").pop() ?? "upload.zip", size: null, mime: null });
  if (Array.isArray(run.upload_paths)) {
    for (const u of run.upload_paths) if (u && typeof u.path === "string") sources.push({
      path: u.path,
      name: typeof u.name === "string" ? u.name : u.path.split("/").pop(),
      size: typeof u.size === "number" ? u.size : null,
      mime: typeof u.mime === "string" && u.mime ? u.mime : null,
    });
  }
  if (sources.length === 0) throw new Error("nothing to extract");

  // idempotency: anything this run already registered (by original name)
  const { data: already } = await db.from("source_files").select("original_path").eq("run_id", runId);
  const registeredNames = new Set((already ?? []).map((r: any) => r.original_path));

  // course-wide content dedupe (augment runs skip files already onboarded)
  const seen = new Map<string, string>();
  const { data: priorFiles } = await db.from("source_files").select("content_hash, original_path").eq("course_id", run.course_id);
  for (const pf of priorFiles ?? []) if (pf.content_hash) seen.set(pf.content_hash, pf.original_path);

  let dupes = 0;
  const readJobs: any[] = [];

  async function registerOversize(originalName: string, sizeBytes: number | null, mime: string | null, existingPath: string | null) {
    const mb = sizeBytes ? Math.round(sizeBytes / (1024 * 1024)) : null;
    const resolvedMime = mime ?? detectMime(originalName, new Uint8Array(0));
    // A big PDF that lives in storage is treated as a TEXTBOOK: we don't skip it, we
    // read only the chapters relevant to this course — entirely by URL, never loading
    // the whole book into memory. (Needs a storage path to stream from; zip entries
    // have none, so those still get parked.)
    if (resolvedMime === "application/pdf" && existingPath) {
      const { data: inserted } = await db.from("source_files").insert({
        course_id: run.course_id, run_id: runId, original_path: originalName,
        storage_path: existingPath, content_hash: null, mime_type: resolvedMime,
        size_bytes: sizeBytes, read_status: "pending", is_textbook: true,
        note: `textbook (${mb ?? "?"}MB) — will read only the chapters relevant to this course`,
      }).select("id").single();
      registeredNames.add(originalName);
      if (inserted) readJobs.push({ run_id: runId, stage: "textbook", file_id: inserted.id, chunk_index: 0 });
      await logEvent(runId, "info", `Textbook detected: ${originalName} — will read only relevant chapters`);
      return;
    }
    await db.from("source_files").insert({
      course_id: run.course_id, run_id: runId, original_path: originalName,
      storage_path: existingPath, content_hash: null, mime_type: resolvedMime,
      size_bytes: sizeBytes,
      read_status: "unsupported",
      note: `too large for processing (${mb ?? "?"}MB > ${MAX_FILE_MB}MB) — compress or split it`,
    });
    registeredNames.add(originalName);
    await logEvent(runId, "warning", `Skipped (too large): ${originalName}${mb ? ` — ${mb}MB` : ""}`);
  }

  // register WITHOUT bytes (no download): for medium-size direct files we trust storage
  async function registerByPath(originalName: string, sizeBytes: number | null, mime: string | null, existingPath: string) {
    const { data: inserted, error: insErr } = await db.from("source_files").insert({
      course_id: run.course_id, run_id: runId, original_path: originalName,
      storage_path: existingPath, content_hash: null, mime_type: mime ?? detectMime(originalName, new Uint8Array(0)),
      size_bytes: sizeBytes,
      read_status: "pending",
    }).select("id").single();
    if (insErr) throw new Error(`db insert failed: ${insErr.message}`);
    registeredNames.add(originalName);
    readJobs.push({ run_id: runId, stage: "read", file_id: inserted!.id });
  }

  async function registerFile(originalName: string, bytes: Uint8Array, existingPath: string | null, storageIdx: number) {
    const hash = bytes.length <= HASH_MAX_BYTES ? await sha256(bytes) : null;
    const mime = detectMime(originalName, bytes);
    const isDup = hash ? seen.has(hash) : false;
    let storagePath: string | null = existingPath;
    if (!isDup) {
      if (hash) seen.set(hash, originalName);
      if (!existingPath) {
        const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
        storagePath = `extracted/${runId}/${storageIdx}-${safeName}`;
        const up = await db.storage.from(BUCKET).upload(storagePath, bytes, { contentType: mime, upsert: true });
        if (up.error) throw new Error(`store failed for ${originalName}: ${up.error.message}`);
      }
    } else { dupes++; storagePath = null; }

    const { data: inserted, error: insErr } = await db.from("source_files").insert({
      course_id: run.course_id, run_id: runId, original_path: originalName,
      storage_path: storagePath, content_hash: hash, mime_type: mime,
      size_bytes: bytes.length,
      read_status: isDup ? "duplicate" : "pending",
      note: isDup ? `duplicate of ${hash ? seen.get(hash) : ""}` : null,
    }).select("id").single();
    if (insErr) throw new Error(`db insert failed: ${insErr.message}`);
    registeredNames.add(originalName);
    if (!isDup) readJobs.push({ run_id: runId, stage: "read", file_id: inserted!.id });
  }

  // ---- chunk 0: direct (non-zip) files — cheap, no downloads beyond small hashes ----
  if (chunk === 0) {
    let di = 0;
    for (const src of sources) {
      const isZip = /\.zip$/i.test(src.name) || /\.zip$/i.test(src.path);
      if (isZip) continue;
      di++;
      if (registeredNames.has(src.name)) continue; // resumed run
      let size = src.size ?? null;
      if (size == null) size = await headSize(src.path); // old runs didn't declare size
      if (size != null && size > MAX_FILE_BYTES) { await registerOversize(src.name, size, src.mime ?? null, src.path); continue; }
      if (size != null && size > HASH_MAX_BYTES) { await registerByPath(src.name, size, src.mime ?? null, src.path); continue; }
      // small file: download to hash + sniff mime
      const dl = await db.storage.from(BUCKET).download(src.path);
      if (dl.error || !dl.data) throw new Error(`could not download ${src.name}: ${dl.error?.message}`);
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) { await registerOversize(src.name, bytes.length, src.mime ?? null, src.path); continue; }
      await registerFile(src.name, bytes, src.path, 1000 + di);
    }
  }

  // ---- zip entries: a flat cursor across all zips, EXTRACT_BATCH per invocation ----
  const zips = sources.filter((s) => /\.zip$/i.test(s.name) || /\.zip$/i.test(s.path));
  const lo = chunk * EXTRACT_BATCH;
  const hi = lo + EXTRACT_BATCH;
  let globalIdx = 0;
  let totalEntries = 0;
  let processedThisChunk = 0;
  let moreRemain = false;

  const zipjs = zips.length > 0 ? await import("npm:@zip.js/zip.js@2.7.45") : null;
  for (const z of zips) {
    if (globalIdx >= hi && totalEntries > 0) { moreRemain = true; break; }
    // STREAM the zip over HTTP ranges — only the central directory + the entries we
    // actually extract ever enter memory. Downloading the whole blob is what kept
    // killing the function (WORKER_RESOURCE_LIMIT).
    const { data: su } = await db.storage.from(BUCKET).createSignedUrl(z.path, 600);
    if (!su?.signedUrl) throw new Error(`could not sign ${z.name}`);
    const zipReader = new zipjs!.ZipReader(new zipjs!.HttpReader(su.signedUrl, { useRangeHeader: true, forceRangeRequests: true, preventHeadRequest: false }));
    const entries = (await zipReader.getEntries()).filter((e: any) => !e.directory && !isJunk(e.filename));
    totalEntries += entries.length;
    if (totalEntries > MAX_FILES) { await zipReader.close(); throw new Error(`too many files (${totalEntries} > ${MAX_FILES})`); }

    for (const entry of entries) {
      globalIdx++;
      if (globalIdx <= lo) continue;          // done in earlier chunks
      if (globalIdx > hi) { moreRemain = true; break; }
      if (registeredNames.has(entry.filename)) continue; // retried chunk
      if ((entry.uncompressedSize ?? 0) > MAX_FILE_BYTES) {
        await registerOversize(entry.filename, entry.uncompressedSize ?? null, detectMime(entry.filename, new Uint8Array(0)), null);
        processedThisChunk++;
        continue;
      }
      const bytes: Uint8Array = await entry.getData!(new zipjs!.Uint8ArrayWriter());
      await registerFile(entry.filename, bytes, null, globalIdx);
      processedThisChunk++;
    }
    await zipReader.close();
    if (moreRemain) break;
  }

  if (readJobs.length > 0) await db.from("onboarding_jobs").insert(readJobs);

  if (moreRemain) {
    // chain the next batch — small steps survive; marathons get killed
    await db.from("onboarding_jobs").insert({ run_id: runId, stage: "extract", chunk_index: chunk + 1 });
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "info", `Unpacking… ${Math.min(hi, totalEntries)}/${totalEntries} files`);
    return;
  }

  // last batch: tally + hand over to reading
  const { count: regCount } = await db.from("source_files").select("id", { count: "exact", head: true })
    .eq("run_id", runId).neq("read_status", "duplicate");
  const { count: dupCount } = await db.from("source_files").select("id", { count: "exact", head: true })
    .eq("run_id", runId).eq("read_status", "duplicate");
  const totalDupes = dupCount ?? 0;
  if ((regCount ?? 0) === 0 && totalDupes > 0) {
    await logEvent(runId, "info", "Everything you added was already in this course — nothing new to process");
  } else if ((regCount ?? 0) === 0) {
    throw new Error("no readable files found in the upload");
  }
  if (totalDupes > 0) await logEvent(runId, "info", `${totalDupes} duplicate ${totalDupes === 1 ? "file" : "files"} skipped`);
  await db.from("onboarding_runs").update({ stage: "read", updated_at: new Date().toISOString() }).eq("id", runId);
  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  const { count: pendCount } = await db.from("onboarding_jobs").select("id", { count: "exact", head: true })
    .eq("run_id", runId).eq("stage", "read").in("status", ["queued", "processing"]);
  if ((pendCount ?? 0) > 0) await logEvent(runId, "stage", `Reading ${pendCount} files…`);
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

  // safety net: never pull an oversize file into worker memory (kills the function)
  let knownSize: number | null = typeof file.size_bytes === "number" ? file.size_bytes : null;
  if (knownSize == null && file.storage_path) {
    knownSize = await headSize(file.storage_path);
    if (knownSize != null) await db.from("source_files").update({ size_bytes: knownSize }).eq("id", file.id);
  }
  if (knownSize != null && knownSize > MAX_FILE_BYTES) {
    if (file.mime_type === "application/pdf" && file.storage_path) {
      // big textbook: read only relevant chapters (handled by the textbook stage)
      await db.from("source_files").update({ is_textbook: true, note: `textbook (${Math.round(knownSize / (1024 * 1024))}MB) — will read only the chapters relevant to this course` }).eq("id", file.id);
      await db.from("onboarding_jobs").insert({ run_id: runId, stage: "textbook", file_id: file.id, chunk_index: 0 });
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      await logEvent(runId, "info", `Textbook detected: ${file.original_path} — will read only relevant chapters`);
      await maybeFinalize(runId, file.course_id);
      return;
    }
    await db.from("source_files").update({
      read_status: "unsupported",
      note: `too large for processing (${Math.round((knownSize ?? 0) / (1024 * 1024))}MB > ${MAX_FILE_MB}MB) — compress or split it`,
    }).eq("id", file.id);
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "warning", `Skipped (too large): ${file.original_path}`);
    await maybeFinalize(runId, file.course_id);
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
      const { getDocumentProxy, extractText } = await import("npm:unpdf@0.12.1");
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
// ---------- stage: textbook (read ONLY the chapters relevant to this course) ----------
// Entirely URL-based: the worker never downloads the book. Self-chains across
// invocations: chunk 0 plans (page count + ToC -> relevant chapter ranges); chunks
// 1..N OCR each planned window by URL; then stitch + understand.
const TEXTBOOK_WINDOW = Number(Deno.env.get("TEXTBOOK_WINDOW") ?? "8"); // pages per OCR call

// Fetch the whole book ONCE per invocation and slice out a small page-range PDF as
// base64. Sending sliced PDFs (<100 pages) is the ONLY way past Anthropic's hard
// "max 100 PDF pages" 400 error — a URL/document to a 900-page book is always rejected.
async function sliceTextbookPages(fileUrl: string, start: number, end: number): Promise<{ b64: string; count: number } | null> {
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { PDFDocument } = await import("npm:pdf-lib@1.17.1");
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total = src.getPageCount();
    const a = Math.max(1, Math.min(start, total));
    const b = Math.max(a, Math.min(end, total, a + 99)); // never exceed 100 pages
    const out = await PDFDocument.create();
    const idxs = Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i);
    const copied = await out.copyPages(src, idxs);
    copied.forEach((p) => out.addPage(p));
    const sliced = await out.save();
    // base64 without blowing the stack on large arrays
    let bin = ""; const CH = 0x8000;
    for (let i = 0; i < sliced.length; i += CH) bin += String.fromCharCode(...sliced.subarray(i, i + CH));
    return { b64: btoa(bin), count: idxs.length };
  } catch (_) { return null; }
}


// Ask Claude how many pages the PDF has, by URL (no download).
// Page count WITHOUT sending the book to the AI. We fetch the raw PDF bytes (range-
// capped) and count page objects from the PDF structure. Robust to scanned books.
async function pdfPageCountByUrl(fileUrl: string): Promise<number | null> {
  try {
    // pull up to ~12MB; page-tree /Count and /Type/Page markers live throughout the file
    const res = await fetch(fileUrl, { headers: { Range: "bytes=0-12000000" } });
    if (!res.ok && res.status !== 206) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("latin1").decode(buf);
    // Prefer the catalog's /Count (total pages); else count /Type/Page occurrences.
    let best: number | null = null;
    const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => parseInt(m[1], 10)).filter((n) => Number.isFinite(n));
    if (counts.length) best = Math.max(...counts);
    const pageMarks = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (pageMarks > 0) best = Math.max(best ?? 0, pageMarks);
    return best && best > 0 ? best : null;
  } catch (_) { return null; }
}

async function doTextbook(job: any) {
  const runId = job.run_id;
  const { data: file } = await db.from("source_files").select("*").eq("id", job.file_id).single();
  if (!file) { await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id); return; }
  const label = file.original_path.split("/").pop();

  const { data: su } = await db.storage.from(BUCKET).createSignedUrl(file.storage_path, 1800);
  if (!su?.signedUrl) throw new Error("textbook file missing in storage");
  const fileUrl = su.signedUrl;

  const CACHE_BATCH = Number(Deno.env.get("TB_CACHE_BATCH") ?? "250"); // pages cached per beat
  const MAX_TB_PAGES = Number(Deno.env.get("TEXTBOOK_MAX_PAGES") ?? "300");
  const cachePath = `tbcache/${runId}/${file.id}.jsonl`; // one JSON line per page: {p, t}
  const textPath = `text/${runId}/${file.id}.txt`;
  const SEP = "\n\u0001\n";

  // Extract text for a page range by slicing a small PDF and running unpdf on the slice.
  async function extractRangeText(bytes: Uint8Array, start: number, end: number): Promise<string[]> {
    const { PDFDocument } = await import("npm:pdf-lib@1.17.1");
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const tot = src.getPageCount();
    const a = Math.max(1, start), b = Math.min(end, tot);
    if (b < a) return [];
    const out = await PDFDocument.create();
    const idxs = Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i);
    const copied = await out.copyPages(src, idxs);
    copied.forEach((p) => out.addPage(p));
    const sliced = await out.save();
    const { getDocumentProxy, extractText } = await import("npm:unpdf@0.12.1");
    const pdf = await getDocumentProxy(sliced);
    const { text } = await extractText(pdf, { mergePages: false });
    return Array.isArray(text) ? text : [String(text ?? "")];
  }
  async function readCache(): Promise<string> {
    try { const dl = await db.storage.from(BUCKET).download(cachePath); if (!dl.error && dl.data) return await dl.data.text(); } catch (_) { /* */ }
    return "";
  }

  const plan = (file.chapter_plan as any) || { phase: "cache", cursor: 0 };

  // ---------- phase: cache (extract text once, in batches, append to cache) ----------
  if (plan.phase === "cache") {
    if (!plan.cursor) await logEvent(runId, "stage", `Reading ${label} (text)…`);
    let total = (typeof file.page_count === "number" && file.page_count > 0) ? file.page_count : null;
    // fetch the book ONCE this beat
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`fetch failed ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!total) {
      const { PDFDocument } = await import("npm:pdf-lib@1.17.1");
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      total = doc.getPageCount();
      await db.from("source_files").update({ page_count: total }).eq("id", file.id);
    }
    const from = (plan.cursor ?? 0) + 1;
    const to = Math.min(from + CACHE_BATCH - 1, total);
    const slice = await extractRangeText(bytes, from, to);
    // append lines to cache
    let lines = "";
    for (let i = 0; i < slice.length; i++) lines += JSON.stringify({ p: from + i, t: (slice[i] || "") }) + "\n";
    const prior = await readCache();
    await db.storage.from(BUCKET).upload(cachePath, new TextEncoder().encode(prior + lines), { contentType: "application/x-ndjson", upsert: true });

    if (to < total) {
      await db.from("source_files").update({ chapter_plan: { phase: "cache", cursor: to } }).eq("id", file.id);
      await db.from("onboarding_jobs").insert({ run_id: runId, stage: "textbook", file_id: file.id, chunk_index: 0 });
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      await logEvent(runId, "info", `Reading ${label}… ${to}/${total} pages`);
      await maybeFinalize(runId, file.course_id);
      return;
    }
    // cache complete -> plan phase
    await db.from("source_files").update({ chapter_plan: { phase: "plan" }, page_count: total }).eq("id", file.id);
    await db.from("onboarding_jobs").insert({ run_id: runId, stage: "textbook", file_id: file.id, chunk_index: 0 });
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "info", `Read ${total} pages of ${label}; selecting chapters…`);
    await maybeFinalize(runId, file.course_id);
    return;
  }

  // load cached page texts (used by plan + read)
  async function loadPages(): Promise<Map<number, string>> {
    const raw = await readCache();
    const m = new Map<number, string>();
    for (const ln of raw.split("\n")) { if (!ln.trim()) continue; try { const o = JSON.parse(ln); if (typeof o.p === "number") m.set(o.p, o.t || ""); } catch (_) { /* */ } }
    return m;
  }
  const total = (typeof file.page_count === "number" && file.page_count > 0) ? file.page_count : 0;

  // ---------- phase: plan (find chapters from cache, classify) ----------
  if (plan.phase === "plan") {
    const pagesMap = await loadPages();
    // detect if this is a real text PDF
    let nonEmpty = 0; for (const t of pagesMap.values()) if ((t || "").trim().length > 40) nonEmpty++;
    const isText = total > 0 && nonEmpty / total > 0.3;
    if (!isText) {
      // scanned book: fall back to OCR path by switching plan to the legacy scanned flow
      await db.from("source_files").update({ chapter_plan: null }).eq("id", file.id);
      await logEvent(runId, "info", `${label}: not enough text — using OCR`);
      await db.from("onboarding_jobs").insert({ run_id: runId, stage: "textbook", file_id: file.id, chunk_index: 0 });
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      // mark as scanned so chunk0 takes OCR branch next time
      await db.from("source_files").update({ note: "__ocr__" }).eq("id", file.id);
      await maybeFinalize(runId, file.course_id);
      return;
    }
    // ===== ToC-first path: if the book has a real table of contents, use it =====
    // Parse the contents pages for "Chapter N Title ... printedPage", then locate each
    // chapter's REAL opening page by title (printed!=physical, and the offset drifts, so
    // we search rather than do arithmetic). This avoids scanning the whole book.
    const tocChapters = (() => {
      let toc = "";
      for (let p = 1; p <= Math.min(25, total); p++) toc += " " + (pagesMap.get(p) || "");
      toc = toc.replace(/\s+/g, " ");
      const out: { num: number; title: string }[] = [];
      const seen = new Set<number>();
      for (const m of toc.matchAll(/Chapter\s+(\d+)\s+([A-Za-z][A-Za-z \-'&]+?)\s+\d{1,4}\b/g)) {
        const num = parseInt(m[1], 10);
        if (Number.isFinite(num) && !seen.has(num)) { seen.add(num); out.push({ num, title: m[2].trim() }); }
      }
      return out.sort((a, b) => a.num - b.num);
    })();

    if (tocChapters.length >= 3) {
      // locate real opening page per chapter, monotonically (in chapter order)
      const frontEnd = Math.min(25, total);
      const openings = new Map<number, number>();
      let cursor = frontEnd + 1;
      for (const ch of tocChapters) {
        const w0 = (ch.title.split(/\s+/)[0] || "").toLowerCase();
        for (let p = cursor; p <= total; p++) {
          const head = (pagesMap.get(p) || "").slice(0, 320).replace(/\s+/g, " ");
          if (new RegExp(`\\bChapter\\s+${ch.num}\\b`).test(head) && (w0.length < 3 || head.toLowerCase().includes(w0))) {
            openings.set(ch.num, p); cursor = p; break;
          }
        }
      }
      const located = tocChapters.filter((c) => openings.has(c.num));
      if (located.length >= 3) {
        const nums = located.map((c) => c.num);
        const ranges = located.map((c, i) => ({
          num: c.num, title: c.title, start: openings.get(c.num)!,
          end: i + 1 < located.length ? openings.get(located[i + 1].num)! - 1 : total,
        }));
        // classify by TITLE (cheap — no need to sample body text; the ToC titles are descriptive)
        const { data: crs } = await db.from("courses").select("title").eq("id", file.course_id).single();
        const titleList = ranges.map((c) => `Chapter ${c.num}: ${c.title}`).join("\n");
        const planPrompt =
          `A textbook has these chapters. The course is "${crs?.title ?? "this course"}". ` +
          `Pick ONLY the chapter numbers whose topics are relevant to this course. Be selective (typically 3-7 chapters). ` +
          `Return ONLY JSON, no fences: {"relevant_chapters":[numbers]}.\n\n` + titleList;
        let relevantNums: number[] = [];
        try {
          const { text: out, usage } = await callClaude(SPINE_MODEL, [{ type: "text", text: planPrompt }], 400);
          await db.from("ai_usage").insert({ run_id: runId, file_id: file.id, stage: "understand", model: SPINE_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
          const parsed = JSON.parse(out.replace(/```json|```/g, "").trim());
          relevantNums = Array.isArray(parsed?.relevant_chapters) ? parsed.relevant_chapters.map((x: any) => parseInt(x, 10)).filter(Number.isFinite) : [];
        } catch (_) { relevantNums = []; }
        const chosen = ranges.filter((c) => relevantNums.includes(c.num)).slice(0, 8);
        if (chosen.length > 0) {
          await db.from("source_files").update({
            chapter_plan: { phase: "read", chosen, ci: 0, cursor: chosen[0].start, kept: 0 },
            page_map: chosen.map((c) => ({ title: `Chapter ${c.num} ${c.title}`, pages: `${c.start}-${c.end}` })),
          }).eq("id", file.id);
          await db.from("onboarding_jobs").insert({ run_id: runId, stage: "textbook", file_id: file.id, chunk_index: 1 });
          await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
          await logEvent(runId, "stage", `Found contents — reading ${chosen.length} relevant chapters of ${label}: ${chosen.map((c) => "Ch " + c.num).join(", ")}`);
          await maybeFinalize(runId, file.course_id);
          return;
        }
        // ToC found but nothing matched -> fall through to scan as a safety net
      }
    }
    // ===== end ToC-first path; fall back to "Chapter N" scan below =====

    // chapter starts (fallback for books without a parseable ToC)
    const chapFirst = new Map<number, number>();
    for (let p = 1; p <= total; p++) {
      const t = pagesMap.get(p) || "";
      for (const m of t.matchAll(/Chapter\s+(\d+)\b/gi)) { const c = parseInt(m[1], 10); if (Number.isFinite(c) && !chapFirst.has(c)) chapFirst.set(c, p); }
    }
    const starts = [...chapFirst.entries()].sort((a, b) => a[0] - b[0]);
    if (starts.length < 2) {
      // no chapter structure -> keep a capped sample so it still contributes
      const chosen = [{ num: 0, start: 1, end: Math.min(MAX_TB_PAGES, total) }];
      await db.from("source_files").update({ chapter_plan: { phase: "read", chosen, ci: 0, cursor: 1, kept: 0 } }).eq("id", file.id);
      await db.from("onboarding_jobs").insert({ run_id: runId, stage: "textbook", file_id: file.id, chunk_index: 1 });
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      await logEvent(runId, "info", `${label}: no chapter markers — keeping first ${Math.min(MAX_TB_PAGES, total)} pages`);
      await maybeFinalize(runId, file.course_id);
      return;
    }
    const ranges = starts.map(([num, start], idx) => ({ num, start, end: idx + 1 < starts.length ? starts[idx + 1][1] - 1 : total }));
    const { data: crs } = await db.from("courses").select("title").eq("id", file.course_id).single();
    const stripBoiler = (s: string) => s.replace(/PROPRIETARY MATERIAL[\s\S]*?(?=Chapter|$)/g, " ");
    const samples = ranges.map((c) => {
      let buf = "";
      for (let p = c.start; p <= Math.min(c.start + 3, c.end); p++) buf += " " + stripBoiler(pagesMap.get(p) || "");
      return `Chapter ${c.num} (p.${c.start}-${c.end}): ${buf.replace(/\s+/g, " ").trim().slice(0, 300)}`;
    }).join("\n\n");
    const planPrompt =
      `A solution manual has these chapters (with a text sample of each). The course is "${crs?.title ?? "this course"}". ` +
      `Pick ONLY the chapter numbers whose topics are relevant to this course. Be selective (typically 2-6 chapters). ` +
      `Return ONLY JSON, no fences: {"relevant_chapters":[numbers]}.\n\n` + samples.slice(0, 14000);
    let relevantNums: number[] = [];
    try {
      const { text: out, usage } = await callClaude(SPINE_MODEL, [{ type: "text", text: planPrompt }], 600);
      await db.from("ai_usage").insert({ run_id: runId, file_id: file.id, stage: "understand", model: SPINE_MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
      const parsed = JSON.parse(out.replace(/```json|```/g, "").trim());
      relevantNums = Array.isArray(parsed?.relevant_chapters) ? parsed.relevant_chapters.map((n: any) => parseInt(n, 10)).filter(Number.isFinite) : [];
    } catch (_) { relevantNums = []; }
    let chosen = ranges.filter((c) => relevantNums.includes(c.num)).slice(0, 8);
    if (chosen.length === 0) {
      await db.from("source_files").update({ read_status: "read", text_path: null, chapter_plan: null, note: "textbook: no chapters matched this course" }).eq("id", file.id);
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      await logEvent(runId, "info", `${label}: no chapters matched this course`);
      await maybeFinalize(runId, file.course_id);
      return;
    }
    await db.from("source_files").update({
      chapter_plan: { phase: "read", chosen, ci: 0, cursor: chosen[0].start, kept: 0 },
      page_map: chosen.map((c) => ({ title: `Chapter ${c.num}`, pages: `${c.start}-${c.end}` })),
    }).eq("id", file.id);
    await db.from("onboarding_jobs").insert({ run_id: runId, stage: "textbook", file_id: file.id, chunk_index: 1 });
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "stage", `Reading ${chosen.length} relevant chapters of ${label}: ${chosen.map((c) => "Ch " + c.num).join(", ")}`);
    await maybeFinalize(runId, file.course_id);
    return;
  }

  // ---------- phase: read (copy chosen chapters from cache to final text) ----------
  if (plan.phase === "read" && Array.isArray(plan.chosen)) {
    const pagesMap = await loadPages();
    const chosen = plan.chosen as { num: number; start: number; end: number }[];
    let kept = plan.kept ?? 0;
    let out = "";
    for (const c of chosen) {
      out += `\n[[CHAPTER ${c.num}]]\n`;
      for (let p = c.start; p <= c.end && kept < MAX_TB_PAGES; p++) { out += `[[PAGE ${p}]]\n` + (pagesMap.get(p) || "").trim() + "\n"; kept++; }
      if (kept >= MAX_TB_PAGES) break;
    }
    await db.storage.from(BUCKET).upload(textPath, new TextEncoder().encode(out.trim()), { contentType: "text/plain", upsert: true });
    await db.from("source_files").update({
      read_status: "read", text_path: textPath,
      note: `using: ${chosen.map((c) => `Chapter ${c.num} (p.${c.start}-${c.end})`).join("; ").slice(0, 280)}`,
      chapter_plan: null,
    }).eq("id", file.id);
    await enqueueUnderstand(runId, file.id);
    // cleanup cache
    try { await db.storage.from(BUCKET).remove([cachePath]); } catch (_) { /* */ }
    await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
    await logEvent(runId, "success", `Read (textbook): ${chosen.length} relevant chapters of ${label} — ${chosen.map((c) => "Ch " + c.num).join(", ")}`);
    await maybeFinalize(runId, file.course_id);
    return;
  }

  // unknown plan state -> reset
  await db.from("source_files").update({ chapter_plan: { phase: "cache", cursor: 0 } }).eq("id", file.id);
  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  await maybeFinalize(runId, file.course_id);
}

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
    // OCR by URL: Claude fetches the file itself from a signed URL — the worker
    // never downloads or parses the scan (this is what kept blowing memory).
    const { data: su } = await db.storage.from(BUCKET).createSignedUrl(file.storage_path, 600);
    if (!su?.signedUrl) throw new Error("file missing in storage");
    const fileUrl = su.signedUrl;

    if (file.mime_type?.startsWith("image/")) {
      const { text, usage } = await callClaude(OCR_MODEL, [
        { type: "image", source: { type: "url", url: fileUrl } },
        { type: "text", text: OCR_PROMPT.replace("{FIRST_PAGE}", "1").replace("{LAST_PAGE}", "1") },
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

    const total: number | null = typeof file.page_count === "number" ? file.page_count : null;
    if (total != null && total > 100) {
      // Anthropic processes at most 100 pages per document request
      await db.from("source_files").update({ read_status: "unsupported", note: `scanned PDF has ${total} pages — over the 100-page OCR limit; split it` }).eq("id", file.id);
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      await logEvent(runId, "warning", `Skipped OCR (over 100 pages): ${label}`);
      await maybeFinalize(runId, file.course_id);
      return;
    }
    const cap = Math.min(total ?? MAX_OCR_PAGES, MAX_OCR_PAGES);
    const idx = job.chunk_index ?? 0;
    const start = idx * OCR_CHUNK_PAGES;
    const end = Math.min(start + OCR_CHUNK_PAGES, cap);

    const { text, usage } = await callClaude(OCR_MODEL, [
      { type: "document", source: { type: "url", url: fileUrl } },
      { type: "text", text: OCR_PROMPT.replace("{FIRST_PAGE}", String(start + 1)).replace("{LAST_PAGE}", String(end)) },
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
      const final = total != null && cap < total ? "partial" : "read";
      await db.from("source_files").update({
        read_status: final, page_count: total ?? file.page_count, text_path: textPath,
        note: total != null && cap < total ? `OCR limited to first ${cap} of ${total} pages` : null,
      }).eq("id", file.id);
      await enqueueUnderstand(runId, file.id);
      await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
      await logEvent(runId, "success", `Read (OCR): ${label}${total != null && cap < total ? " (partial)" : ""}`);
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
    const msg = (e as Error).message;
    const transient = /429|529|rate_limit|overloaded|timed out|timeout|5\d\d/i.test(msg);
    if (transient) {
      // Rate-limited even after waiting. Do NOT instant-requeue (that caused a tick
      // storm). Record it as classified-other with a marker; it can be repaired later
      // via ?reclassify, and the run is allowed to finish so the user isn't blocked.
      result = { category: "other", category_confidence: 0, summary: `Rate limited — re-classify later: ${msg}`.slice(0, 200), contains_questions: false, topics: [], chapters: [] };
    } else {
      result = { category: "other", category_confidence: 0, summary: `Classification error: ${msg}`.slice(0, 200), contains_questions: false, topics: [], chapters: [] };
    }
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

  // circuit breaker: a job that has been attempted too many times is retired so it can
  // never drive an endless retry/tick loop (claim_onboarding_job increments attempts).
  const MAX_ATTEMPTS = Number(Deno.env.get("JOB_MAX_ATTEMPTS") ?? "6");
  if ((job.attempts ?? 0) > MAX_ATTEMPTS) {
    await db.from("onboarding_jobs").update({ status: "failed" }).eq("id", job.id);
    await logEvent(job.run_id, "warning", `Gave up on a ${job.stage} step after ${job.attempts} attempts`);
    // try to let the run finish with whatever else is done
    const { data: r } = await db.from("onboarding_runs").select("course_id").eq("id", job.run_id).single();
    if (r) await maybeFinalize(job.run_id, r.course_id);
    return { worked: false };
  }

  try {
    if (job.stage === "extract") await doExtract(job);
    else if (job.stage === "read") await doRead(job);
    else if (job.stage === "ocr") await doOcr(job);
    else if (job.stage === "textbook") await doTextbook(job);
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

// One beat: claim + process one job, chain the next if anything was done.
// Path C: drain a BATCH of jobs per invocation, looping internally, instead of each
// job spawning a new invocation. One cron call per minute now does many jobs, so total
// invocations are ~1/min (≈43K/month — under even the free tier). No self-chain = no
// storm possible. Stops early to stay within the background-task wall-clock budget.
const DRAIN_MAX_JOBS = Number(Deno.env.get("DRAIN_MAX_JOBS") ?? "40");
const DRAIN_BUDGET_MS = Number(Deno.env.get("DRAIN_BUDGET_MS") ?? "320000"); // ~320s of ~400s

async function runBeat() {
  const startedAt = Date.now();
  try {
    for (let i = 0; i < DRAIN_MAX_JOBS; i++) {
      if (Date.now() - startedAt > DRAIN_BUDGET_MS) break; // leave headroom; cron picks up the rest
      const { worked } = await tick();
      if (!worked) break; // queue empty (or a retired job) — done for now
    }
  } catch (_) { /* job-level failures are recorded by the stages themselves */ }
}

// Respond IMMEDIATELY and do the work as a background task: request handlers are
// killed at 150s wall-clock, but background tasks get ~400s — slow OCR calls on big
// scans need that headroom (this was the 504 IDLE_TIMEOUT / 150s kills).
function startBeatInBackground(): boolean {
  try {
    // @ts-ignore EdgeRuntime provided by Supabase
    EdgeRuntime.waitUntil(runBeat());
    return true;
  } catch (_) {
    return false;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-worker-secret, content-type, apikey",
};
const jsonHeaders = { "Content-Type": "application/json", ...CORS };

Deno.serve(async (req) => {
  // CORS preflight (the browser sends OPTIONS before a cross-origin POST)
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (req.method === "GET") {
    const url = new URL(req.url);
    if (url.searchParams.get("tick") === "1") {
      const bg = startBeatInBackground();
      if (!bg) await runBeat(); // local dev without EdgeRuntime
      return new Response(JSON.stringify({ ok: true, worker: WORKER_VERSION, accepted: true, hint: "working in the background — watch the course activity feed; refresh to push again" }), { headers: jsonHeaders });
    }
    const reCourse = url.searchParams.get("reclassify");
    if (reCourse) {
      // re-run understand for any doc that failed classification (e.g. a rate-limit error
      // stored as category "other" with the error in its summary)
      const { data: bad } = await db.from("source_files")
        .select("id, run_id, original_path, summary, category")
        .eq("course_id", reCourse).in("read_status", ["read", "partial"]);
      const targets = (bad ?? []).filter((f: any) =>
        (f.category === "other" || !f.category) && /error|rate.?limit|429|529|timed out/i.test(String(f.summary ?? "")));
      for (const f of targets) {
        await db.from("source_files").update({ summary: null, category: null }).eq("id", f.id);
        await db.from("onboarding_jobs").insert({ run_id: f.run_id, stage: "understand", file_id: f.id });
      }
      const bg = startBeatInBackground();
      if (!bg) await runBeat();
      return new Response(JSON.stringify({ ok: true, worker: WORKER_VERSION, requeued: targets.map((t: any) => t.original_path) }), { headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ ok: true, worker: WORKER_VERSION }), { headers: jsonHeaders });
  }
  if (req.headers.get("x-worker-secret") !== WORKER_SECRET) return new Response("forbidden", { status: 403, headers: CORS });
  const bg = startBeatInBackground();
  if (!bg) await runBeat();
  return new Response(JSON.stringify({ accepted: true }), { headers: jsonHeaders });
});
