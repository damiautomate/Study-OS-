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

---

## Login (added)

Real accounts, layered on top of the guest flow so nothing breaks.
- The app still starts as an anonymous guest (instant, no friction).
- **/login** lets you *create an account* — if you're currently a guest, it
  **upgrades that guest session in place**, so your existing courses/progress carry
  over (no data loss). Or *sign in* to reach your account from another device.
- The home page shows your email + sign out, or a "Sign in / create account" link.
- Supabase setup: **Authentication → Providers → Email** enabled. For the smoothest
  test, you can turn **"Confirm email" off** (Auth → Providers → Email); with it on,
  new accounts must confirm via the emailed link before sign-in works.

## Agent Slice 4 — Coaching actions (added)

The agent can now *teach*, not just plan. Each plan item gets three buttons:

- **Explain** — teaches the topic from **its own source materials** (reads the
  slides/notes tagged to that topic and explains in your course's terms, ending with
  a self-check). Falls back to a general explanation if no material is tagged.
- **Practice** — pulls a **real past question** tagged to that topic and breaks it
  into doable steps (without handing over the full answer).
- **Why it matters** — a short, real-world use of the topic, using **web search**
  for current, concrete examples.

### Setup
1. **SQL editor:** run `0010_agent_coaching.sql` (after 0009).
2. **Edge Functions → create `agent-coach`**, paste `supabase/functions/agent-coach/index.ts`,
   **Verify JWT off**, same secrets as the other functions (`ANTHROPIC_API_KEY`,
   `WORKER_SECRET`; `COACH_MODEL` optional, defaults to Haiku). Deploy.
3. Redeploy the web app.

### How it works
- Buttons call `/api/coach`, which fires the `agent-coach` function (grounded in your
  materials / question bank, web search only for the "why it matters" mode). Results
  stream back into the panel via Realtime and are saved per topic.

### Honest notes / next
- Answer-*checking* against stored solutions isn't here yet — we stored whether a
  solution exists, not its text — so practice scaffolds the approach rather than
  grading your answer. That's a clean follow-up.
- Still ahead: proactive **drift intervention** (the agent reaching out when you go
  quiet), and the richer phases (capstone, real free-choice).

---

## Agent Slice 5 — Drift intervention + engagement (added) · code-only

The agent stops being purely reactive. No new migration — this reuses `study_log`,
the agent tables, and the topic→materials links already in place.

### What changed
- **Engagement signals** in the heartbeat snapshot: days since last studied, active
  days in the last 7, and current-plan adherence (items done / plan age). The agent
  now sees not just *what* you know but *whether you're showing up*.
- **Proactive outreach**: the prompt instructs the agent to reach out first when
  you've gone quiet (3+ days) or adherence is low — with ONE tiny, concrete re-entry
  step matched to your accountability style, never shaming, and to shrink scope (not
  pile on) when you're behind. It acknowledges consistency when you're showing up.
- **Sweep cadence**: the cron now runs a beat for any onboarded course the agent
  hasn't touched in ~20h (was: only if no recent plan) — so the daily check-in can
  actually catch drift. (Still needs the cron configured; the manual button also
  triggers a beat for testing.)
- **Materials on every recommendation** (your note): each plan item now shows
  exactly **which of your notes to read** and **how many questions** are tagged to
  that topic — the recommendation points at your real resources, not just a title.

### Files changed
`supabase/functions/agent-heartbeat/index.ts` (redeploy it) and the course-page
agent panel. Nothing else to run.

### Still ahead
- Tapping a material to actually open it (signed URL to the stored file).
- Answer-checking against stored solutions; richer phases (capstone, free-choice).

---

## Tap-to-open materials (added) · code-only

The material names on each plan item are now **tappable** — clicking one opens the
actual file (the slide/note PDF, image, etc.) in a new tab.

### How it works
- Files live in the private `course-uploads` bucket under worker-written paths, so
  the client can't read them directly. `/api/material` verifies you own the file
  (via RLS on `source_files`) and returns a **short-lived signed URL** (5 min) minted
  with the service role. The browser opens that URL.

### Files changed
`app/api/material/route.ts` (new) and the agent panel. No migration — just redeploy
the web app.

### Still ahead
- Answer-checking against stored solutions (needs storing solution text).
- Richer phases: capstone, free-choice course.

---

## Agent Slice 6 — Answer-checking (added)

The agent can now check a worked answer and **teach from the mistake**, grading
against the **real solution from your own materials** when one exists. This turns an
attempt into the strongest signal in the student model.

### Deploy (order matters)
1. **SQL editor:** run `0011_agent_answer_checking.sql` (after 0010). Adds
   `questions.solution_text` and a `question_attempts` log.
2. **Redeploy `onboarding-worker`** — the questions stage now also captures the
   verbatim solution text when it appears in a document (never invents one).
3. **Redeploy `agent-coach`** — adds the `check` mode (grading + mastery update).
4. **Redeploy the web app.**

### The flow
- Tap **Practice** on a topic → a real past question + how-to-approach steps.
- Work it out, type your answer, tap **Check my answer**.
- The agent returns a **verdict** (correct / partial / incorrect), a score, and
  **specific** feedback — what you got right, the exact gap, and the one fix. It does
  not just dump the solution.
- That attempt updates your mastery for the topic (solid / developing / shaky),
  logs an attempt, and feeds the heartbeat — so the agent re-plans around what you
  actually missed.

### Grounding & honesty (by design)
- If the question has an official solution in your materials, grading is **against
  that solution** (`graded_on: official_solution`).
- If it doesn't, the agent grades from the topic's materials + reasoning, labels the
  result **"no official key"**, and stays appropriately humble. It never fabricates a
  solution.

### Important: applies to newly-onboarded courses
Solution text is captured **during onboarding**, so courses onboarded *before* this
update (e.g. your existing ones) won't have stored solutions — their checks use the
materials-only fallback. **Re-onboard a course** to capture solutions going forward.

### Still ahead
- Richer phases: capstone, free-choice course.
- Adding materials to a course *after* onboarding (parked backlog).

---

## Phase 6 — Real-World Application (added, done to spec)

Built properly this time, against the Phase 6 design: motivation, not a content dump.
Replaces the earlier thin "Why it matters" button.

### Deploy
1. **SQL editor:** run `0012_phase6_application.sql` (after 0011). Adds the cached
   `application_notes` table.
2. **Redeploy `agent-coach`** — adds the `application` mode + checkpoint trigger.
3. **Redeploy the web app.**

### What it does (Phase 6 stages)
- **Checkpoint trigger** — when a graded attempt makes a topic *understood* (solid),
  it generates that topic's application note **once, automatically**, so it lands
  while the concept is fresh. You can also tap **Why it matters** to generate on
  demand.
- **Researched + cited** — uses web search for concrete, current real-world uses and
  **cites the real sources it found** (clickable). Paraphrased, never reproduced,
  never fabricated.
- **Tied to your goal** — framed around what you said you want to be able to do.
- **Cross-course links** — looks across your *other onboarded courses' spines* and
  surfaces only **genuine** connections (it validates the linked course is really
  yours before showing it).
- **Cached + revisitable** — stored as one note per concept (`application_notes`),
  so research isn't re-run on every view (cost discipline, per the spec).

### Files
`supabase/functions/agent-coach/index.ts` (redeploy), `app/courses/[id]/AgentPanel.tsx`,
migration `0012`.

---

## Where the phases stand (honest map)

- **Phase 1 Onboarding** — done.
- **Phase 2 Planning** — done: editable deadlines/capacity + a deterministic,
  deadline-aware week-by-week schedule with a revision buffer and re-plan.
- **Phase 3 Tracking** — done; strengthened by evidence from answer-checking.
- **Phase 4 Daily loop / consistency** — done as heartbeat + drift intervention.
- **Phase 5 Practice** — done (practice + answer-checking).
- **Phase 6 Application** — done to spec (this slice).
- **Phase 7 Capstone** — done.
- **Phase 8 Free course** — done.

---

## Phase 2 — Semester Planning & Scheduling (added, done to spec)

A real, **deadline-aware** week-by-week schedule — and the deadlines are yours to set,
because school dates shift.

### Deploy
1. **SQL editor:** run `0013_phase2_scheduling.sql` (after 0012). Adds editable
   `courses.exam_date / test_date / weight`, `student_profile.study_days_per_week`,
   and the `schedule_items` table.
2. **Redeploy `agent-heartbeat`** — it now prefers *this week's scheduled topics* when
   planning, so the weekly focus lines up with the semester plan.
3. **Redeploy the web app.**

### What it does (Phase 2 stages)
- **Editable inputs (your ask):** on the course page → **Dates & capacity**, set your
  **exam date**, **test date**, course **importance (1–5)**, and study **hours/day +
  days/week**. When a date shifts, change it and **Re-plan** — everything rebalances.
- **Assessment-aware allocation `[CODE]`:** spreads the course's topics (in spine
  order) across the weeks **before your exam**, and **reserves the last 1–2 weeks for
  revision** instead of first-time reading. Fully deterministic — no AI guessing dates.
- **Concrete weeks:** a week-by-week view with **this week** highlighted, the **TEST**
  and **EXAM** weeks marked, learn-vs-revise per topic, and check-offs.
- **Realism check `[GATE]`:** shows *hours/week needed vs your capacity* and warns when
  you're over — so you adjust inputs and re-plan rather than getting a fantasy schedule.
- **Re-plan from progress:** regenerating **skips topics you've already mastered**
  (from answer-checking) and re-spreads the rest across the remaining weeks — so falling
  behind compresses the plan instead of piling up debt.

### Honest scope notes
- Sequencing uses the **spine order** (already a sensible teaching order from
  onboarding). The spec's AI *prerequisite* graph (`depends_on[]`) is a future add.
- Scheduling targets the **exam** as the deadline; the test week is marked on the
  calendar. Splitting material pre-test vs post-test is a future refinement.
- One course at a time for now; a single merged multi-course calendar is the next step.

---

## Multi-course dashboard (added) · code-only, web app redeploy only

Built because the real load is 8–11 courses, and the place overwhelm lives is "what do
I do today, across everything?" The home screen is now a cross-course cockpit, not a list.

- **Overwhelm guard:** a single line at the top when multiple exams fall within 2 weeks,
  naming the nearest and telling you to protect the closest first.
- **This week (all courses):** each course with a built schedule shows its this-week
  task count (done/total) and how far its exam is — sorted by nearest deadline.
- **Merged deadline calendar:** every course's test/exam dates in one sorted list with
  "in N wks · date" — the Phase 2 "one calendar of all deadlines," finally cross-course.
- **Course cards at a glance:** mastery progress (topics solid / total), a "quiet" flag
  when a course has gone untouched ~4+ days, and the next deadline. Tap to open.
- **Scales:** all of it is a handful of aggregate queries (not per-course loops), so it
  holds up across a full courseload.

Everything is deterministic from existing data — no new tables, no AI calls. UI is kept
deliberately simple (clear sections, tappable cards) pending the later design pass; the
nav structure (dashboard → course → schedule/agent) is the part that matters now.

---

## Phases 7 & 8 + cross-course allocator (added)

### Deploy
1. **SQL editor:** run `0014_phase7_8.sql` (after 0013). Adds `capstones`,
   `capstone_milestones`, and free-course columns on `courses`.
2. **Redeploy `agent-coach`** — adds `capstone_propose`, `capstone_plan`, and
   `curriculum` modes.
3. **Redeploy the web app.**

### Phase 7 — Capstone (the visible end-goal)
On each course (and surfaced on the dashboard):
- **Propose** → the agent suggests 2–3 real capstones (paper/project) grounded in the
  course's spine and tied to your stated motivation.
- **Choose one** → it becomes active.
- **Plan milestones** → 4–6 ordered milestones, each tagged with the **topics you must
  understand first**. A milestone stays **🔒 locked until those topics are `solid`** (from
  answer-checking) — so the capstone literally unlocks as you learn, closing the
  motivation loop. The final milestone uses web search for real publish/showcase venues.

### Phase 8 — Free-choice course (fuel)
- **+ Free-choice course** on the dashboard → name it, say what you want to learn, set an
  optional target date. The agent **builds you a curriculum** (modules → topics) — no
  uploads needed — and it flows through the same plan / loop / practice / application
  engine. No exam calendar; your **target date** drives urgency and scheduling. Always
  available alongside school work.
- (Practice/answer-checking on a curriculum-only course uses the materials-only path,
  since there's no past-paper bank — honest by design.)

### Cross-course allocator (the multi-course step)
The dashboard's **Focus this week** is now one prioritised, capacity-aware list across
**all** courses: it takes every course's scheduled-this-week work, orders it by **nearest
deadline** (then learn-before-revise), and shows the **top N that fit your weekly hours**
(`hrs/day × days/week ÷ ~1.5`), with the rest noted as "+N more". When exams cluster, the
few things that matter most surface first — across the whole courseload, not per silo.

---

## Phase scorecard — all phases built
1 Onboarding · 2 Planning/scheduling (dated, editable) · 3 Tracking · 4 Daily loop + drift ·
5 Practice + answer-checking · 6 Application · 7 Capstone · 8 Free course — plus a
multi-course dashboard and cross-course weekly allocator.

### Honest remaining refinements (not blockers)
- Capstone milestone prerequisites map within the **anchor course**; a single capstone
  spanning multiple courses' topic graphs is a future extension.
- The allocator prioritises and caps the weekly list across courses; a full solver that
  re-slices each course's *semester* allocation around competing deadlines is the deeper
  version.
- AI **prerequisite graph** for sequencing (vs. spine order) and **generated practice**
  when a question bank is thin remain open design choices from the spec.

---

## Redesign — Step 1: structure, navigation, new visual foundation (web-only)

Addresses three of the four gripes at once (clutter, navigation, generic look). No
migration, no function changes — redeploy the web app.

- **New design system** (`nocturne editorial`): cooler deep ink, warm ivory, a cleaner
  brass accent; editorial serif (Newsreader) + refined body (Hanken) + a **mono for
  stats/labels**; lamp-glow depth, refined surfaces, scrollbars, focus rings. Same token
  *names* (nothing breaks), fresh values.
- **App shell** (`app/Nav.tsx`): a slim sticky top bar on every screen — wordmark → home,
  account/sign-out. You can always get back; no more standalone islands.
- **Tabbed course pages**: the long scroll is split into **Overview · Plan · Capstone ·
  Materials**. Plan holds the schedule + agent; Materials holds the map, question bank,
  and inventory. Much less overwhelming across many courses.
- **Free-course fix**: curriculum-only courses (no upload run) no longer hit the
  "no onboarding run" dead-end.

### Still to come in the redesign
- **Step 2 — deeper visual polish** of each panel (schedule, agent, capstone, dashboard).
- **Step 3 — functional refinements**: one unified "what now" plan, a real *today* view,
  add-materials/capture-solutions after onboarding, auto reading-state, optional
  out-of-app nudges.

---

## Redesign — Step 2 (visual polish) + safe functional refinements (web-only)

No migration, no function changes — redeploy the web app.

**Visual polish**
- **Unified mono "label" system**: every section header, status pill, kind tag, and
  stat now uses the same tracked uppercase mono treatment — the signature detail of the
  new look, applied consistently across dashboard, schedule, agent, capstone, and course
  tabs. Numbers (deadlines, progress, milestones, counts) are mono for an "instrument"
  feel.
- Consistent cards, spacing, hover/focus states, and the refreshed nocturne palette now
  read as one intentional system rather than per-screen variation.

**Functional refinements (the low-risk, high-value ones)**
- **Auto reading-state**: opening a note now marks that topic as *being read*
  (`in_progress`) and logs the activity — tracking reflects what you actually do, no
  extra taps.
- **"Start here" today-nudge**: the single highest-priority item in the cross-course
  Focus list is highlighted, so "what do I do first" is unmistakable.

### Remaining functional refinements (deliberately a separate pass — they're features, not polish, and rushing them risks the working app)
- **One unified "what now" plan** — have the agent work *the schedule* so there's a
  single source of truth (today the schedule's week and the agent's plan are parallel).
- **Add materials / capture solutions after onboarding** — upload more into an existing
  course and re-run the relevant stages (also enables real answer-checking on older
  courses).
- **Out-of-app nudges** (email/WhatsApp) for drift — consistency when you're not in the
  app.

---

## Redesign v2 — "Paper & Flame" (full reset · web-only)

A complete visual + structural redesign in response to feedback that the dark/gold look
felt AI-generic and navigation still scrolled too much. No migration, no function
changes — redeploy the web app.

### The look
- **Paper & Flame**: warm cream paper surface, near-black ink, ONE hot tangerine accent
  (actions, streaks), deep green for mastery. Feels like a beautifully printed student
  planner, not an AI dashboard.
- Fonts: **Bricolage Grotesque** (display) + **Schibsted Grotesk** (body) +
  **Spline Sans Mono** (numbers/labels). Soft paper shadows (`.card`), tactile round
  checkboxes, check-pop micro-animation, rounded-2xl geometry.
- Token names unchanged — values re-meant (ink=page, paper=text, gold=flame), so the
  entire app flipped consistently; legacy dark "wells" retoned for paper.

### Mobile-first structure (the navigation fix)
- **Bottom tab bar** on mobile (thumb-first): **Today · Courses · You**; same nav inline
  on desktop. Safe-area aware.
- **Today (`/`)** — the new home: date + greeting, **streak flame** (computed from
  study_log, with "streak safe / keep it alive" state), **Up next: top 3** across all
  courses (urgency-sorted, "start" marker, satisfying check-off), next 3 deadlines.
  Open app → know exactly what to do → do it → flame grows. Short by design.
- **Courses (`/courses`)** — compact exam-aware grid (mastery bar, quiet flag, next
  date), Add + Free-choice actions, friendly empty state.
- **You (`/you`)** — month snapshot (days studied, topics mastered), editable goal +
  capacity, account/upgrade-from-guest.
- **Course pages** — sticky horizontally-scrollable pill tabs; schedule and coach SPLIT
  into separate tabs (**This week · Coach · Capstone · Library**) so no tab is a long
  scroll; coverage folded into Library.

### Healthy "addictive" mechanics
Streak + today-state dot + "start here" + check-pop + monthly stats — engagement aimed
at *showing up to study*, consistent with the app's purpose (needing it less over time),
not dark-pattern retention.

---

## Multi-file uploads + Add materials after onboarding

### Deploy (order matters)
1. **SQL editor:** run `0015_add_materials.sql` (after 0014).
2. **Redeploy `onboarding-worker`** (new extract + `assign` stage + augment phase machine).
3. **Redeploy the web app.**

### Multi-file onboarding (no more zip-only)
- **New course** now accepts **multiple files** — PDFs, images, notes, CSVs, and/or zips,
  mixed freely. Each uploads directly from the browser (per-file progress), zips are
  unpacked server-side, direct files are registered in place (no copy).
- Dedupe is **course-wide by content hash**, so the same file never gets processed twice.

### Add materials to an ONBOARDED course (Library tab → "Add materials")
- Drop in new notes/textbook chapters/past questions any time. A background **augment
  run** reads + OCRs + understands them, then a new **assign** stage merges them into
  the EXISTING course map:
  - files are attached to the existing topics they cover (AI-mapped with exact-title
    validation + a deterministic title-match safety net — no hallucinated links);
  - genuinely new content can add a topic under the right existing module;
  - new question documents feed the question bank (only the new docs are scanned —
    old ones aren't reprocessed);
  - coverage counts recompute; mastery rows are seeded for any new topics;
  - the course **stays onboarded** throughout — no re-review, nothing disturbed.
- Live merge status streams into the panel; when done the Library refreshes.
- This also means you can now **capture solutions for older courses**: re-add the past
  papers and the questions stage stores their solution text for real answer-checking.

### Material referencing — verified end-to-end
The chain a recommendation rides on: spine/assign writes `topic.source_file_ids` →
the Coach panel shows **Read: <note names>** per plan item (tappable → ownership-checked
signed URL → the actual file opens) → question counts per topic → Explain/Practice pull
from those same files/questions. The Coach panel now also **live-refreshes its topic→
materials map** when a merge lands, so newly added notes appear on recommendations
without a reload. (Curriculum/free courses benefit too: add real materials and they
attach to the generated topics.)

---

## Textbook chapter relevance + exact-page references & saved excerpts

### Deploy (order matters)
1. **SQL editor:** run `0016_page_refs.sql` (after 0015).
2. **Redeploy `onboarding-worker`** AND **`agent-coach`**.
3. `npm install` includes **pdf-lib** (in package.json) — just redeploy the web app.

### Page-aware extraction (the foundation)
- PDF reading and OCR now embed **[[PAGE n]] markers** in all extracted text (OCR is
  told each chunk's real starting page), so everything downstream knows exactly where
  content lives.

### Textbooks: only the chapters that matter
- The understand stage now detects **chapters with page ranges** (from the ToC and
  headings) and judges each chapter's **relevance to THIS course** — then extracts
  topics **only from the relevant chapters**. The chapter map is stored
  (`source_files.page_map`) and the Library shows "using: Ch 4 (p.118-167); …" on the
  textbook. A 900-page book stops polluting the course map with 14 unrelated chapters.

### Exact-page references (`material_refs`)
- Spine and assign now record, per topic-material pair, the **specific pages** that
  topic uses ("12-18"), deterministically taken from where the file's own topic entries
  say the content lives. The Coach shows **"Lecture6.pdf · p.12-18"** on each plan item.

### Saved page excerpts — individually or collectively
- Tapping a paged reference calls **/api/excerpt**, which slices **just those pages**
  out of the stored PDF (pdf-lib), **saves the excerpt** (`excerpts/{ref}.pdf`) so it's
  built once and reused, and opens it. Non-PDFs or unpaged refs open the whole file.
- **"open all pages ↗"** on a topic builds a combined **study pack**: every referenced
  page for that topic, across all its materials, in one PDF.
- The Coach's **Explain** is now grounded on those exact pages (text sliced by the
  markers, labeled "From X (pages 12-18)") instead of whole files — tighter, cheaper,
  more accurate.

### Honest notes
- Page data appears for **newly processed files** (markers are written at read/OCR
  time). Older files keep working via the whole-file fallback; re-add a material to get
  its page-level refs.
- Page-number accuracy on born-digital PDFs is exact (extractor-counted); on OCR'd
  scans it relies on the model following the numbered-marker instruction — verified by
  prompt design, worth eyeballing on your first scanned textbook.

---

## Hotfix — upload errors, duplicate courses, stuck onboarding diagnosis

- **Real error messages**: the "[object Object]" failure now shows the actual error
  (all upload/create flows stringify unknown errors properly).
- **No more ghost duplicates**: if run creation fails, /api/courses deletes the course
  it just created, so retrying can't leave duplicate "building" courses behind.
- **Reliable worker kick**: /api/courses and /api/augment now give the worker
  fire-and-forget kick up to ~1.5s to actually leave the building before the
  serverless function exits (previously it could be killed before sending).
- **Deployment verification**: the worker now answers a plain **GET** at its URL with
  `{ ok: true, worker: "v7-pages" }` — open the function URL in a browser to confirm
  the new version is the one actually running. The first activity line also shows the
  version: "Opening your upload… (worker v7-pages)".
- The course page shows a hint when a run sits with zero activity (worker likely not
  deployed/booting).

---

## Verification pass (real tooling, not just builds)

**What was tested and the results:**
- **Deno type-check (`deno check`) on all 3 Edge Functions — PASS.** This caught and
  fixed 4 real type errors (2 were genuine bugs: fallback understand results missing
  the new `chapters` field — the likely cause of the failed worker deploy; plus a
  crypto BufferSource strictness issue and a zip.js optional-method call).
- **All 3 Edge Functions BOOTED locally under Deno** with the same entrypoint Supabase
  uses: worker answers `GET → {"ok":true,"worker":"v7-pages"}`, all three return 403
  without the secret, coach returns `{"ok":true}` on an authorized empty call. Logs clean.
- **Unit tests for page logic — PASS** (parsePages ranges/lists/garbage/null;
  sliceByPages single page, range, exclusion, legacy-text fallback). Caught and fixed a
  formatting bug in page slicing.
- **Production server smoke test:** all 8 pages return HTTP 200 with no SSR error
  markers; all 7 API routes return clean validation errors (400) instead of crashing.

**The stuck "Uploading 1/2" bug (your screenshot) — root cause & fix:**
- supabase-js `upload()` exposes **no progress** and can sit silently on very large
  files; and Supabase's **default per-file limit is 50MB** — a raw textbook/solution-
  manual PDF often exceeds it (your earlier zips were compressed under it).
- New `lib/upload.ts`: uploads now go through a **signed upload URL + XHR** with a
  **live percentage** ("Uploading 1/2 — name… 37%"), a **90s stall timeout** with a
  clear error instead of hanging forever, and a **pre-upload size guard** that names
  the file and tells you the fix (zip it / split it / raise the limit in Supabase →
  Storage → Settings). Used by both New course and Add materials.

**What cannot be tested from here (requires your live keys):** the actual AI pipeline
runs against your Supabase + Anthropic account. The version ping + versioned first
activity line exist precisely so you can confirm the deployed worker in seconds.
