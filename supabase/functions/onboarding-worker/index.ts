// =============================================================
// Study OS · onboarding-worker  (Supabase Edge Function, Deno)
//
// One bounded unit of work per invocation (keeps CPU under the 2s
// limit), then self-invokes to process the next — so beats chain
// back-to-back without waiting on cron. Cron is only a watchdog.
//
// Stages:
//   extract -> unzip, hash, type, dedupe, store files, queue reads
//   read    -> one file: page-count + native text, or flag needs_ocr
// =============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { ZipReader, BlobReader, Uint8ArrayWriter } from "npm:@zip.js/zip.js@2.7.45";
import { getDocumentProxy, extractText } from "npm:unpdf@0.12.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("WORKER_SECRET")!;
const BUCKET = "course-uploads";

// safety caps (extract refuses anything past these)
const MAX_FILES = 500;
const MAX_TOTAL_UNCOMPRESSED = 300 * 1024 * 1024; // 300 MB
const MAX_ATTEMPTS = 4;

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- helpers ----------
async function logEvent(
  runId: string,
  kind: string,
  message: string,
  data?: unknown,
) {
  await db.from("run_events").insert({ run_id: runId, kind, message, data: data ?? null });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function detectMime(name: string, bytes: Uint8Array): string {
  const b = bytes;
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return "application/zip";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  const lower = name.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

function isJunk(path: string): boolean {
  if (path.includes("..") || path.startsWith("/")) return true; // path traversal
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? "";
  if (path.startsWith("__MACOSX/") || path.includes("/__MACOSX/")) return true;
  if (base.startsWith(".")) return true; // .DS_Store etc.
  return false;
}

function fireNextTick() {
  try {
    // @ts-ignore EdgeRuntime is provided by the Supabase runtime
    EdgeRuntime.waitUntil(
      fetch(`${SUPABASE_URL}/functions/v1/onboarding-worker`, {
        method: "POST",
        headers: {
          "x-worker-secret": WORKER_SECRET,
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }).catch(() => {}),
    );
  } catch (_) { /* no-op */ }
}

async function failJobAndRun(job: any, runId: string, msg: string) {
  if (job.attempts >= MAX_ATTEMPTS) {
    await db.from("onboarding_jobs").update({ status: "failed" }).eq("id", job.id);
    await db.from("onboarding_runs").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", runId);
    await logEvent(runId, "error", `Stopped: ${msg}`);
  } else {
    // release for retry
    await db.from("onboarding_jobs").update({ status: "queued", locked_at: null }).eq("id", job.id);
    await logEvent(runId, "warning", `Retrying after error: ${msg}`);
  }
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

  const seen = new Map<string, string>(); // hash -> original_path
  let dupes = 0;
  let idx = 0;
  const readJobs: { run_id: string; stage: string; file_id: string }[] = [];

  for (const entry of files) {
    idx++;
    const bytes: Uint8Array = await entry.getData(new Uint8ArrayWriter());
    const hash = await sha256(bytes);
    const mime = detectMime(entry.filename, bytes);
    const safeName = entry.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
    const storagePath = `extracted/${runId}/${idx}-${safeName}`;

    const isDuplicate = seen.has(hash);
    if (!isDuplicate) {
      seen.set(hash, entry.filename);
      const up = await db.storage.from(BUCKET).upload(storagePath, bytes, { contentType: mime, upsert: true });
      if (up.error) throw new Error(`store failed for ${entry.filename}: ${up.error.message}`);
    } else {
      dupes++;
    }

    const { data: inserted, error: insErr } = await db.from("source_files").insert({
      course_id: run.course_id,
      run_id: runId,
      original_path: entry.filename,
      storage_path: isDuplicate ? null : storagePath,
      content_hash: hash,
      mime_type: mime,
      size_bytes: entry.uncompressedSize ?? bytes.length,
      read_status: isDuplicate ? "duplicate" : "pending",
      note: isDuplicate ? `duplicate of ${seen.get(hash)}` : null,
    }).select("id").single();
    if (insErr) throw new Error(`db insert failed: ${insErr.message}`);

    if (!isDuplicate) readJobs.push({ run_id: runId, stage: "read", file_id: inserted!.id });
  }
  await zipReader.close();

  if (dupes > 0) await logEvent(runId, "info", `${dupes} duplicate ${dupes === 1 ? "file" : "files"} skipped`);

  // queue one read job per real file, advance the run
  if (readJobs.length > 0) await db.from("onboarding_jobs").insert(readJobs);
  await db.from("onboarding_runs").update({ stage: "read", updated_at: new Date().toISOString() }).eq("id", runId);
  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  await logEvent(runId, "stage", `Reading ${readJobs.length} files…`);
}

// ---------- stage: read (one file) ----------
async function doRead(job: any) {
  const runId = job.run_id;
  const { data: file } = await db.from("source_files").select("*").eq("id", job.file_id).single();
  if (!file) { await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id); return; }
  if (file.read_status !== "pending") { await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id); return; } // idempotent

  let status: string = "needs_ocr";
  let pageCount: number | null = null;
  let textPath: string | null = null;
  let note: string | null = null;

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
      } else {
        status = "needs_ocr";
        note = "scanned / image-based PDF — queued for OCR (Slice 2)";
      }
    } else if (file.mime_type === "text/plain" || file.mime_type === "text/csv") {
      const text = new TextDecoder().decode(bytes);
      textPath = `text/${runId}/${file.id}.txt`;
      await db.storage.from(BUCKET).upload(textPath, new TextEncoder().encode(text), { contentType: "text/plain", upsert: true });
      status = "read";
    } else {
      status = "needs_ocr";
      note = "not natively readable yet — Slice 2";
    }
  } catch (e) {
    status = "failed";
    note = `read error: ${(e as Error).message}`.slice(0, 300);
  }

  await db.from("source_files").update({ read_status: status, page_count: pageCount, text_path: textPath, note }).eq("id", file.id);
  await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);

  // progress + completion check
  const { count: total } = await db.from("source_files").select("id", { count: "exact", head: true }).eq("run_id", runId).neq("read_status", "duplicate");
  const { count: pending } = await db.from("source_files").select("id", { count: "exact", head: true }).eq("run_id", runId).eq("read_status", "pending");
  const done = (total ?? 0) - (pending ?? 0);
  const label = file.original_path.split("/").pop();
  await logEvent(runId, status === "read" ? "success" : "info", `Read ${done} of ${total}: ${label}`, { status });

  if ((pending ?? 0) === 0) {
    await db.from("onboarding_runs").update({ stage: "done", status: "done", updated_at: new Date().toISOString() }).eq("id", runId);
    await db.from("courses").update({ status: "onboarded" }).eq("id", file.course_id);
    await logEvent(runId, "stage", "Inventory ready");
  }
}

// ---------- main tick ----------
async function tick(): Promise<{ worked: boolean }> {
  const { data: job, error } = await db.rpc("claim_onboarding_job");
  if (error) { console.error("claim error", error); return { worked: false }; }
  if (!job) return { worked: false };

  try {
    if (job.stage === "extract") await doExtract(job);
    else if (job.stage === "read") await doRead(job);
    else await db.from("onboarding_jobs").update({ status: "done" }).eq("id", job.id);
  } catch (e) {
    await failJobAndRun(job, job.run_id, (e as Error).message);
  }
  return { worked: true };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-worker-secret") !== WORKER_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const { worked } = await tick();
  if (worked) fireNextTick(); // chain to the next unit immediately
  return new Response(JSON.stringify({ worked }), { headers: { "Content-Type": "application/json" } });
});
