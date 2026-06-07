# Study OS — Slice 1: Ingest & Inventory

Create a course, upload a zip of its materials, and a background pipeline
unzips it, removes duplicates, identifies every file, and reads text from the
readable ones — streaming live progress to a chat-style feed that ends on a
clean inventory.

**Stack:** Next.js 15 (Vercel) · Supabase (Postgres, Storage, Edge Functions, Realtime) · no local terminal required.

---

## What's inside

```
app/                      Next.js UI (home, new course, live onboarding view)
app/api/courses/          creates the course + run + first job, kicks the worker
lib/supabase/             browser / server / admin clients
lib/semester.ts           derives test & exam windows from the start date
supabase/migrations/      the database schema (run this in the SQL editor)
supabase/functions/       the onboarding-worker Edge Function
supabase/config.toml      turns off the JWT check for the worker function
```

The worker does **one file per beat** and then re-invokes itself, so it never
trips the Edge Function CPU limit while still moving fast. Cron is only a
watchdog that restarts a stalled run.

---

## Setup (all via web consoles)

### 1. Repo + Supabase project
- Create a fresh GitHub repo and upload these files.
- Create a Supabase project. From **Project Settings → API**, copy the
  **Project URL**, the **anon** key, and the **service_role** key.

### 2. Turn on what the app needs
- **Authentication → Providers → Anonymous:** enable it. (Slice 1 signs users in
  anonymously so row-level security works without a login screen — swap in real
  auth later; every row is already keyed to a `user_id`.)
- **Database → Extensions:** enable `pg_cron` and `pg_net`.

### 3. Database
- Open the **SQL editor**, paste all of
  `supabase/migrations/0001_slice1_ingest.sql`, and run it.
  This creates the tables, RLS, the job-claim function, the private
  `course-uploads` bucket + upload policies, and turns on Realtime.

### 4. The worker function
- **Edge Functions → Create a function**, name it exactly `onboarding-worker`,
  and paste `supabase/functions/onboarding-worker/index.ts`.
- In the function's **settings**, turn **Verify JWT off** (it's gated by a
  secret instead).
- **Edge Functions → Secrets**, add:
  `WORKER_SECRET = <a long random string you invent>`
  (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)
- Deploy.

### 5. The watchdog cron
In the SQL editor (replace the two placeholders):

```sql
select cron.schedule(
  'onboarding-worker-watchdog',
  '30 seconds',
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT.supabase.co/functions/v1/onboarding-worker',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-worker-secret', 'YOUR_WORKER_SECRET'),
    body    := '{}'::jsonb
  );
  $$
);
```

### 6. Deploy the web app
- Import the GitHub repo into **Vercel**.
- Add environment variables (Vercel → Settings → Environment Variables):
  ```
  NEXT_PUBLIC_SUPABASE_URL       = https://YOUR-PROJECT.supabase.co
  NEXT_PUBLIC_SUPABASE_ANON_KEY  = your-anon-key
  SUPABASE_SERVICE_ROLE_KEY      = your-service-role-key
  WORKER_SECRET                  = the same string from step 4
  ```
- Deploy. Open the site, add a course, upload a zip, watch it work.

---

## What it does / doesn't do (by design)

**Does:** unzip, dedupe (by content hash), type-detect, page-count, and extract
text from native-text PDFs and plain-text files; live progress; grouped inventory.

**Doesn't yet (next slices):** OCR / vision for scanned (image) PDFs — those are
flagged `needs_ocr` rather than failed. Word/PowerPoint full-text, AI document
understanding, classification, the topic spine, and the question bank all come
after. No AI calls happen in this slice, so it costs nothing to run.

## Honest notes

- The worker relies on `unpdf` and `@zip.js/zip.js` running under Deno. They're
  built for serverless/edge, but if a specific import misbehaves on deploy, that
  function file is the one place to check first.
- A genuinely huge single PDF could exceed the 2s CPU budget while parsing; if
  so, that one file is marked `failed` with a note and the run still completes —
  it never takes the whole run down.
- Caps: 500 files and 300 MB uncompressed per zip (adjustable at the top of the
  worker).

---

## Slice 2 — OCR (added)

Image-based files (scanned PDFs, photos) are now read into text with Claude
vision. No rasterization happens in the function — the Anthropic API renders PDF
pages server-side — so this rides on the same worker with one new `ocr` stage.

### Extra setup for Slice 2
1. **SQL editor:** run `supabase/migrations/0002_slice2_ocr.sql` (after 0001).
2. **Edge Function → Secrets**, add:
   ```
   ANTHROPIC_API_KEY = your-central-anthropic-key
   OCR_MODEL         = claude-haiku-4-5-20251001   # optional; this is the default
   ```
3. Redeploy the `onboarding-worker` function (paste the updated `index.ts`).

### Switching the OCR model
`OCR_MODEL` is just an env var — change it and redeploy, no code edits:
- `claude-haiku-4-5-20251001` — cheapest, fast, default. Best for most scans.
- `claude-sonnet-4-6` — step up for messy handwriting / poor scans.
- `claude-opus-4-8` — highest quality, highest cost; rarely needed for OCR.

### Cost & limits
- One AI call per image, and per 20-page chunk of a scanned PDF.
- OCR is capped at 200 pages per document (`MAX_OCR_PAGES` in the worker);
  beyond that a file is marked **partial**.
- Every call is logged to `ai_usage` (tokens per file) so a course's cost is visible.
- Word/PowerPoint are **not** OCR cases — they stay flagged `unsupported` for a
  later slice (they need office parsing, not vision).

### New inventory outcomes
`read` · `partial` (page cap hit) · `ocr_failed` · `unsupported` · plus the
Slice 1 ones. A run finishes when no jobs remain — which now covers OCR too.
