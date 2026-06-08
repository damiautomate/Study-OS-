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

---

## Slice 3 — Understanding & classification (added)

Every readable document now gets one structured AI pass that works out **what it
is**, summarises it, flags whether it holds questions, and lists the topics it
covers. The inventory rows show a category tag + summary instead of just "read".

### Extra setup for Slice 3
1. **SQL editor:** run `supabase/migrations/0003_slice3_understanding.sql` (after 0002).
2. **Edge Function → Secrets** (optional — defaults to Haiku):
   ```
   UNDERSTAND_MODEL = claude-haiku-4-5-20251001
   ```
   Same options as OCR (`claude-sonnet-4-6` for sharper categorisation).
3. Redeploy the `onboarding-worker` function.

### How it works
- The chain is now `extract → read → ocr → understand → done`.
- When a file becomes readable, an `understand` job is queued. It feeds the text
  to the model, which returns strict JSON: `category` (slides / textbook / notes
  / assignment / test / exam / solutions / outline / other), `category_confidence`,
  `summary`, `contains_questions`, `topics`. The JSON is **validated** before it's
  stored — bad output is retried once, then falls back to `other` and is flagged.
- Low-confidence classifications show a small **"check this"** marker in the UI
  (correcting them in-app is a planned fast-follow).
- Each call is logged to `ai_usage` with `stage = understand`, separate from OCR.
- Input is capped at ~120k characters/document; very large texts are summarised
  from their first portion (noted).

### Honest notes
- Topics are grounded to the **document**, not to page numbers — our stored text
  is page-merged. Page-level citations need page-segmented text, a later refinement.
- Deferred to Slice 4+: collapsing near-duplicate slide versions, the single
  ordered **topic spine** for the whole course, and the in-app classification
  correction UI.

---

## Slice 4 — Topic spine (added)

Once every document is understood, the worker runs **one** course-level pass that
merges all the per-document topics into a single ordered, de-duplicated
two-level map (modules → topics) — the syllabus spine. This is the answer to
"what do I actually need to study, and in what order," and it's the first thing
the study agent will read later.

### Extra setup for Slice 4
1. **SQL editor:** run `supabase/migrations/0004_slice4_spine.sql` (after 0003).
2. **Edge Function → Secrets** (optional): `SPINE_MODEL` (defaults to Haiku;
   `claude-sonnet-4-6` gives a more coherent ordering on big courses).
3. Redeploy the worker.

### How it works
- The chain is now `extract → read → ocr → understand → spine → done`.
- When all per-file work is finished, a single `spine` job is enqueued (exactly
  once, via an atomic stage flip). It feeds every document's category + topics to
  the model, which returns an ordered `{modules:[{title, topics:[…]}]}` outline.
- Topic → source-file links are computed **deterministically** in code (matching
  titles), not by the model, so no source ids are hallucinated.
- The course page shows a live **Course map** once it's built; each topic notes
  how many materials cover it.

### Deferred (later slices)
- Collapsing near-duplicate slide *versions* (beyond exact duplicates).
- The **question bank** (Slice 5) and **coverage/gap report + review** (Slice 6),
  which complete the onboarding subsystem.

---

## Slice 5 — Question bank (added)

After the spine is built, the worker extracts individual past questions from every
document flagged as containing questions (assignments, tests, exams, solutions),
tags each to a topic on the spine, and records its type, difficulty, and whether a
solution is shown. This is the raw material that later makes practice concrete.

### Extra setup for Slice 5
1. **SQL editor:** run `supabase/migrations/0005_slice5_questions.sql` (after 0004).
2. **Edge Function → Secrets** (optional): `QUESTIONS_MODEL` (defaults to Haiku).
3. Redeploy the worker.

### How it works
- The chain is now `extract → read → ocr → understand → spine → questions → done`.
- After the spine, one `questions` job runs per question-bearing document. It feeds
  the document text **plus the spine's topic titles** to the model, which returns
  strict JSON of `{text, type, difficulty, topic, has_solution}` per question.
- Topic tagging is matched **deterministically** back to a real spine topic id
  (the model can only pick from the supplied list); unmatched → untagged.
- The course page shows a live **Question bank** card: total, topics covered,
  count with solutions, and a per-type tally.

### Honest notes / deferred
- `has_solution` is detected **within the same document** (worked solutions). Matching
  a separate solutions PDF to an exam's questions is cross-document linking, deferred.
- Up to 200 questions are taken per document (cap in the worker).
- Remaining to finish onboarding: **Slice 6 — coverage & review** (gap report:
  topics with no materials, topics with no questions, unreadable files; plus the
  final confirmation).

---

## Slice 6 — Coverage & review (added) · onboarding complete

The final onboarding step. After the question bank, a deterministic `coverage`
pass (no AI) computes, per topic, how many materials and questions cover it, and
surfaces the honest gaps. Onboarding then hands off to **you** for confirmation
rather than auto-completing.

### Extra setup for Slice 6
1. **SQL editor:** run `supabase/migrations/0006_slice6_coverage.sql` (after 0005).
2. Redeploy the worker. (No new secrets.)

### How it works
- Full chain: `extract → read → ocr → understand → spine → questions → coverage → done`.
- `coverage` fills each topic's `source_count` / `question_count` and logs a summary.
- On finish the course moves to **`review`** (not straight to `onboarded`). The
  course page shows a **Coverage & gaps** panel — topics with no readings, topics
  with no questions, untagged questions, unreadable files — and a **"Looks right —
  finish onboarding"** button that flips the course to `onboarded`. That's the
  human-in-the-loop gate from the original workflow.

### Onboarding subsystem is now complete
A course goes from a messy zip to: a clean inventory, every file read (incl. OCR),
each document understood & classified, one ordered topic spine, a topic-tagged
question bank, and an honest coverage report — confirmed by you.

**This is the point to run one real course end-to-end before the agent layer
(student model, heartbeat, phases 2–8) gets built on top of it.**

---

## Agent Slice 1 — Student foundation (added)

The first piece of the intelligence layer: the data the agent will read about *you*.

### Setup
1. **SQL editor:** run `supabase/migrations/0007_agent_student_foundation.sql` (after 0006).
2. No new function/secrets. Redeploy the web app.

### What it adds
- `student_profile` — a one-minute intake at **/welcome** (goal, what you'd love to
  build, what's tripped you up before, how you want to be pushed, study hours). The
  home page prompts for it if it's missing. Seeds the slow-changing layers of the
  student model. No AI — a plain form.
- `student_mastery` — one row per (you, topic), seeded the moment you click
  **finish onboarding** on a course: every spine topic starts `not_started` /
  `unknown`. This is the per-topic state the agent reads to decide what you study.
  The course page shows "tracking your progress across N topics" once seeded.

### What's next
- **Agent Slice 2 — heartbeat skeleton:** cron wakes the agent, it compiles a
  snapshot (profile + mastery + course KB) and produces a study plan via one
  reasoning call with a tiny validated action set. First time it *thinks*.
- **Agent Slice 3 — tracking loop:** record reading/practice → update mastery +
  engagement → drift detection.

---

## Agent Slice 2 & 3 — Heartbeat + tracking loop (added)

The agent now *thinks*. Once a course is onboarded, an **Your agent** panel appears
on the course page.

### Setup
1. **SQL editor:** run `0008_agent_heartbeat.sql` then `0009_agent_tracking.sql` (after 0007).
2. **Edge Functions → create `agent-heartbeat`**, paste `supabase/functions/agent-heartbeat/index.ts`,
   turn **Verify JWT off**, and make sure the function has the same secrets as the
   worker (`ANTHROPIC_API_KEY`, `WORKER_SECRET`; `AGENT_MODEL` optional, defaults to
   Haiku — set `claude-sonnet-4-6` for sharper planning). Deploy.
3. (Optional, for the daily "presence") add a Supabase cron that POSTs `{}` to the
   `agent-heartbeat` function with the `x-worker-secret` header — same shape as the
   worker watchdog cron, just the other function URL. It sweeps onboarded courses
   that haven't had a beat in ~20h.
4. Redeploy the web app.

### How it works (Slice 2 — heartbeat)
- The agent compiles a **snapshot** — your profile, per-topic mastery, the course
  spine, weeks-to-test/exam, and the last note it sent — and makes ONE reasoning
  call that returns a strict-JSON situation read + a small **validated action set**:
  `set_plan` (3–6 ordered topics with reasons), `message_student` (a note matched to
  how you like to be pushed), or `hold`. Plan topics are matched back to real spine
  topics in code; nothing invented. Every action is logged to `agent_actions`.
- Trigger it manually with **Plan my week**, or let the cron wake it daily.

### How it works (Slice 3 — tracking)
- On each plan item you mark understanding (Shaky / Getting it / Solid) or tick it
  done. That updates `student_mastery` and stamps `last_active_at` + a `study_log`
  row. The next heartbeat reads that updated state (including **days since last
  studied**), so the loop closes: perceive → plan → you act → it re-perceives.

### Honest notes / next
- The reasoning prompt already encodes the guardrails (match accountability style,
  never shame, cut scope near exams rather than pile on), but those are only as good
  as the model follows them — worth watching the first few plans.
- Not yet built: the richer action families (re-explain a stuck topic, scaffold a
  hard question, surface real-world hooks, advance a capstone), drift *intervention*
  (the agent proactively reaching out when you go quiet), and the engagement-signal
  layer of the student model. Those are the next slices.
