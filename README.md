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

---

## Hotfix v8-bigfile — the WORKER_RESOURCE_LIMIT (546) crash loop

**Diagnosis (from your Edge Function logs):** HTTP 546 `WORKER_RESOURCE_LIMIT` —
Supabase killed the worker for exceeding free-tier CPU/memory (~2s CPU / 256MB). The
extract stage loaded each file fully into memory and SHA-256 hashed it; a ~100MB
solution-manual PDF blows that instantly. Because the function died mid-job, the job
never recorded failure — it was reclaimed as stale and retried forever (the repeating
546s in your logs are the cron re-trying the same doomed job).

**Fixes (worker `v8-bigfile`):**
- Uploads now declare `size` + `mime` from the browser, so the worker can decide
  **without downloading**: direct files over `MAX_FILE_MB` (default 45, env-tunable)
  are registered as `unsupported` with a clear note ("too large — compress, split into
  chapters, or raise MAX_FILE_MB") and **never enter memory**. The rest of the course
  processes normally.
- Zip entries are size-checked via their header **before** decompression.
- A post-download fallback catches undeclared sizes; `doRead` has the same guard for
  any legacy rows.
- Hashing (dedupe) only runs on files ≤ 20MB (`HASH_MAX_MB`) — big files skip the
  CPU-heavy hash instead of dying on it.
- Version ping now reports `v8-bigfile`.

**Recovery steps:**
1. Redeploy `onboarding-worker` with this file; confirm GET shows
   `{"ok":true,"worker":"v8-bigfile"}`.
2. The stuck job resumes automatically (cron) — this time it will skip the oversize
   PDF with a visible "Skipped (too large)" event and finish the rest of the course.
3. Delete the duplicate "Circuits and Systems II" course rows in Table Editor.
4. For the solution manual itself: compress it, split it into chapter PDFs (best — the
   chapter-relevance feature then maps them precisely), or raise `MAX_FILE_MB` (worker
   env) *and* your Storage upload limit — noting bigger files cost more worker headroom.

---

## Hotfix v9-chunked — why v8 still hit WORKER_RESOURCE_LIMIT, and the real fix

**Why v8 still died:** (1) the stuck job was created by the OLD build, so its
upload records carried no declared size — and v8's fallback was "download, then
check," but on Edge the download itself is the kill. (2) Extract did the ENTIRE
zip (download → unzip → hash → re-upload every entry) in ONE invocation, which can
exceed the ~2s CPU budget on a big zip even when every file is small.

**v9 architecture (same pattern as the OCR stage):**
- **HEAD-sizing:** files with no declared size get sized via a HEAD request on a
  signed URL — never downloaded to find out they're too big.
- **No pointless downloads:** direct files over 20MB (HASH_MAX_MB) are registered
  by path without downloading at all; only small files are pulled for dedupe hashing.
- **Chunked, self-chaining extraction:** zip entries are processed
  `EXTRACT_BATCH` (default 4) per invocation with a flat cursor across zips; each
  invocation chains the next (`Unpacking… 8/27 files` events) — no single call ever
  does marathon work. Resumable + idempotent: a retried chunk skips files already
  registered, so crashes can't duplicate rows.
- Version ping: `{"ok":true,"worker":"v9-chunked"}`.

**Recovery:** redeploy the worker, confirm the ping says v9-chunked, and the stuck
job resumes itself (you'll see "Unpacking… X/Y" progress). Still delete the duplicate
"Circuits and Systems II" rows in Table Editor when convenient.

---

## v10-stream — the actual root cause, fixed and PROVEN

**Root cause (visible across all three 546 logs — same ~5s death):** every version,
including the "chunked" one, still **downloaded the whole zip into memory** before
touching entries — and every invocation also paid the memory cost of importing the
heavy PDF libraries at module top. The blob + libraries together is what
WORKER_RESOURCE_LIMIT was killing, every time, at the same point.

**v10 changes (architecture, not patches):**
- **Zips are STREAMED over HTTP range requests** (zip.js HttpReader on a signed URL):
  only the central directory and the entries actually being extracted ever enter
  memory. *Proven with a real end-to-end test:* a zip served over real HTTP ranges —
  entry listing, text entry content, and a 3MB binary all streamed byte-exact.
- **Lazy library loading:** unpdf (read), pdf-lib (ocr), zip.js (extract) are now
  imported inside their stages. An extract invocation never loads PDF parsers at all.
- **HEAD-sizing everywhere:** unknown-size files (old runs!) are sized via HEAD on a
  signed URL in BOTH extract and read — nothing is ever downloaded to find out it's
  too big.
- Safer free-tier defaults: MAX_FILE_MB=25, EXTRACT_BATCH=3 (both env-tunable up if
  you upgrade your Supabase plan).
- Ping: `{"ok":true,"worker":"v10-stream"}`.

**Immediate cleanup (stops the crash loop now):** in the SQL editor:
```sql
delete from courses where title = 'Circuits and Systems II';
```
(cascades the broken runs/jobs/files). Then re-create the course once — the new UI
declares sizes up front, shows upload %, and v10 streams the rest.

---

## v11-urlocr — OCR with zero worker memory (the last 546)

**The good news first:** v10 fixed extraction — the logs show a long run of 200s,
files reading, OCR chunks progressing, oversize files parked correctly. The remaining
546 came from a different stage: **doOcr still downloaded each scanned PDF and parsed
it with pdf-lib on every chunk** — image-heavy scans make that parse enormous.

**v11:** OCR now sends Claude a **signed URL** (`document`/`image` source type "url")
and a page-range instruction ("Transcribe ONLY pages X–Y… [[PAGE k]] markers"). Claude
fetches the file itself — the worker never downloads, never parses, never base64s a
scan. pdf-lib is gone from the worker entirely. Scans over 100 pages (Anthropic's
per-request page limit) are marked clearly to split.

The in-flight OCR jobs resume automatically once v11 is deployed (stale jobs are
reclaimed within ~2 minutes). Ping: `{"ok":true,"worker":"v11-urlocr"}`.

Note: with URL chunking the whole document counts as input per chunk call; raise
`OCR_CHUNK_PAGES` (e.g. 12–15) to reduce the number of calls if cost matters.

---

## v12-tick — resuming dead chains (why "nothing happened" after deploying v11)

**Root cause:** the worker is invoked by (a) a kick when you create a course, (b) its
own self-chain, or (c) a cron watchdog. The 546 killed the self-chain mid-run, and the
cron watchdog was designed-for but **never actually configured** — so after deploying
v11 there was simply nothing left to invoke it. The queue (with your half-finished
OCR jobs) sits intact, waiting.

**Three layers so this can never strand you again:**
1. **Browser resume:** open
   `https://<project>.supabase.co/functions/v1/onboarding-worker?tick=1`
   — each load does one unit of work AND restarts the self-chain. Refresh and watch
   `worked: true`; the activity feed comes back to life.
2. **In-app "resume ↻" button** on the course activity card (calls `/api/kick`).
3. **Set up the cron (do this once):** Supabase Dashboard → **Cron** → Create job →
   schedule `* * * * *` (every minute) → type **Edge Function** →
   `onboarding-worker`, method POST, and add header `x-worker-secret: <your secret>`.
   With it, any stalled queue resumes within a minute, forever, no humans involved.
   (Same pattern later for `agent-heartbeat` daily sweeps.)

Ping: `{"ok":true,"worker":"v12-tick"}`.

---

## v13-bg — beating the 150s wall-clock limit (504 IDLE_TIMEOUT / 546 @150s)

**Diagnosis from the logs:** invocations dying at exactly ~150,000ms — the Edge
Function REQUEST wall-clock limit. URL-OCR works (chunks keep completing), but on big
scans Anthropic processes the whole document per call, and one slow call can outlive
the entire request budget. Hour-long activity gaps also confirm the cron is still not
configured — every kill stranded the queue until manually poked.

**v13 changes:**
- The worker now **responds instantly** and runs each beat as a **background task**
  (`EdgeRuntime.waitUntil`) — background tasks get ~400s of wall clock instead of 150s.
  No more 504 IDLE_TIMEOUT; slow OCR calls have room to finish.
- **Anthropic calls have a hard 110s timeout** (`CLAUDE_TIMEOUT_MS` env) with backoff
  retry — a hung call fails the attempt and retries instead of consuming the budget.
- `?tick=1` and POST both return `{accepted:true}` immediately; work continues in the
  background. /api/kick and the cron need only ~5s timeouts now.

**CRON — required, two-minute setup (the missing piece all along):**
SQL editor (replace YOUR_WORKER_SECRET; enable pg_cron + pg_net under Database →
Extensions first if needed):
```sql
select cron.schedule(
  'onboarding-worker-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://gffyiaykiqbkpsseifsn.supabase.co/functions/v1/onboarding-worker',
    headers := '{"Content-Type":"application/json","x-worker-secret":"YOUR_WORKER_SECRET"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);
```
With this, any stall self-heals within a minute, forever. Ping: `v13-bg`.

---

## v14-ratelimit — handling the Anthropic 429 (free-tier 10k input tokens/min)

**What the screenshots showed:** the pipeline SUCCEEDED — all 10 docs read, OCR'd,
understood (incl. the 43-page TEST REVIEW). Two leftovers:
1. Lecture_V landed as category "other" with `Claude 429: rate_limit_error … 10,000
   input tokens per minute` — a free-tier Anthropic per-minute token ceiling hit when
   several understand calls fell in the same minute. The old backoff capped at 45s and
   gave up; it also stored the error as the category.
2. The textbook sits in Waiting by design (over size limit) — not a bug.

**Fixes:**
- callClaude now treats 429 properly: honors `retry-after` /
  `anthropic-ratelimit-*-reset` headers, and otherwise waits a full ~60s for the
  per-MINUTE window to refill (up to 6 attempts), instead of giving up at 45s.
- A transient failure (429/529/5xx/timeout) during understand no longer poisons the
  record — the file is left unclassified and its job re-queued, so a later beat (or the
  cron) re-classifies it cleanly.
- MAX_UNDERSTAND_CHARS default lowered 30k→20k (~5k tokens) so a single doc fits the
  free-tier window with margin.
- **One-time repair for the doc already stuck as "other":** open
  `…/functions/v1/onboarding-worker?reclassify=<COURSE_ID>` once. It re-queues any
  doc whose classification failed with an error and processes it. (COURSE_ID is the
  uuid in the course page URL.)

Ping: `v14-ratelimit`.

### If rate limits keep biting
The free Anthropic tier (10k input tokens/min) is the real constraint with big slide
decks. Options: add credits to raise your tier (cleanest), or set worker env
`MAX_UNDERSTAND_CHARS` lower (e.g. 12000) to shrink each call. The pipeline will still
complete either way — it now waits the limit out rather than failing.

---

## v15-nostorm — STOP the tick storm (runaway invocations / "EXCEEDING USAGE LIMITS")

**What happened:** hundreds of worker POSTs per second, all 200s, no visible progress,
quota burning. Cause was mine: three different places called `fireNextTick()` (runBeat,
the POST handler, and v14's understand-retry), `fireNextTick` had **no concurrency
guard**, AND the v14 understand-retry **instantly re-queued its own job** — so with the
cron also ticking, invocations fanned out exponentially. The textbook was NOT being
read (it's parked in Waiting); the queue was just thrashing.

**EMERGENCY STOP (run in SQL editor if a storm is active):**
```sql
select cron.unschedule('onboarding-worker-tick');
update onboarding_jobs set status = 'done'
where run_id in (select id from onboarding_runs where course_id in
  (select id from courses where title = 'Circuits and Systems II'));
```

**Structural fixes so it can never recur:**
- **One and only one** place chains now: `runBeat()`. Removed the fire calls in the
  extract branch and the understand-retry.
- `fireNextTick()` is **single-flight** — a per-invocation guard means at most ONE next
  tick is ever spawned, even if buggy code calls it repeatedly (unit-tested: 100
  invocations × 3 attempted fires → exactly 100 chains, zero fan-out).
- The understand rate-limit path **no longer re-queues itself** — it records the doc as
  "other (re-classify later)" and lets the run finish; repair later via `?reclassify`.
- **Circuit breaker:** any job attempted more than `JOB_MAX_ATTEMPTS` (default 6) is
  retired and the run allowed to finalize — no job can drive an endless loop.

**After deploying v15:** re-create the cron (the safe SQL from the v13 notes). The
queue moves at a sane ~1 invocation per beat. Ping: `v15-nostorm`.

---

## v16-textbook — read ONLY the relevant chapters of a textbook (no whole-book reads)

### Deploy (order matters)
1. SQL editor: run `0017_textbook.sql` (after 0016).
2. Redeploy `onboarding-worker`. 3. Redeploy web app.

**The instruction implemented:** when a textbook is uploaded, find the chapter(s)
relevant to the course and use only those — never the whole book.

**How it works (100% URL-based — the worker never downloads the book):**
- A big PDF in storage is now flagged `is_textbook` and routed to a new **textbook**
  stage instead of being parked in Waiting.
- **Plan (chunk 0):** gets the page count by URL, then reads ONLY the front-matter /
  table of contents (first ≤25 pages) by URL and asks the AI which chapters are
  relevant to THIS course, with their printed page ranges.
- **Read (chunks 1..N):** OCRs ONLY those chapters' page ranges, in small ≤8-page
  windows, by URL — self-chaining one window per invocation (memory-safe, storm-safe via
  the v15 single-flight guard + attempt cap). A hard page budget (`TEXTBOOK_MAX_PAGES`,
  default 80) caps total pages read; windowing is unit-tested to stay in-range and never
  exceed the cap.
- The extracted chapter text then flows through the normal understand → spine →
  material-refs path, so the textbook's relevant pages become referenceable like any
  other material ("Textbook · Ch4 · p.118-125").
- If NO chapter matches the course, it reads nothing and says so — it never falls back
  to reading the whole book.

**For your already-stuck textbook:** after deploying v16, it will be picked up from
Waiting on the next tick (the doRead oversize guard now reroutes big PDFs to the
textbook stage). Watch for "Scanning … for relevant chapters…" then "Reading … Ch X
p.A-B". Tunables: `TEXTBOOK_MAX_PAGES` (80), `TEXTBOOK_WINDOW` (8).

Ping: `v16-textbook`.

---

## v17-drain (Path C) — no self-chaining, storm impossible, near-zero invocations

**Why everything stalled despite a healthy v16:** Supabase Edge **invocations hit
503% of the free-tier 500K/month** cap (from the storms), so Supabase throttled the
function — a correct deploy simply wouldn't run. (Anthropic was fine: $14.87 credit
left, only $3.72 spent — the storms burned cheap *requests*, not money.)

**Path C — the permanent fix:**
- The worker no longer invokes itself. `runBeat()` now **drains a batch** (up to
  `DRAIN_MAX_JOBS`, default 40) in one invocation, looping internally until the queue
  is empty or it nears the wall-clock budget (`DRAIN_BUDGET_MS`, default ~320s).
- `fireNextTick` is **deleted** — there is no code path that calls the worker from
  itself, so a tick storm is now structurally impossible.
- The cron (one call/minute) drives it: **~43K invocations/month — under even the free
  tier.** This class of problem cannot recur.

Re-create the cron (safe SQL from the v13 notes). Ping: `v17-drain`.

### Finish TODAY without waiting or upgrading — local-worker-runner.html
Because Supabase only throttles invocations *it* hosts, you can drive the same worker
from your own browser:
1. Open `local-worker-runner.html` (double-click the file — it runs locally).
2. Paste your worker URL and your `WORKER_SECRET` value.
3. Click **Auto-run**. It calls your worker every few seconds; each call batch-drains
   jobs. Watch the course Activity feed fill in; stop when the log shows the queue is
   empty. (Secret stays in your browser; uses no cron and ~no hosted invocations since
   the work runs when *you* call it.)

This finishes the textbook + spine + questions + coverage now, on free tier.

---

## v18-cors — fixes "Failed to fetch" in the local runner

**Cause:** the local-runner page POSTs cross-origin to the worker, but the worker sent
no CORS headers, so the browser blocked the response ("Failed to fetch"). The GET ping
worked because address-bar navigation isn't a cross-origin fetch.

**Fix:** the worker now returns `Access-Control-Allow-Origin: *` (+ allowed methods/
headers) on every response and answers the `OPTIONS` preflight. Verified locally:
preflight returns the headers, POST carries them.

**Instant unblock without redeploying** (works on any worker version): open
`https://<project>.supabase.co/functions/v1/onboarding-worker?tick=1` in the address
bar and refresh every few seconds — each load drains a batch (no CORS involved).

After deploying v18, the local runner's **Auto-run** works as intended. Ping: `v18-cors`.

---

## v19-textbook2 — textbook ingestion that actually completes

**Why v16's textbook path failed ("Couldn't open textbook"):** it made TWO calls that
sent the entire 17MB scanned book to the model — one just to count pages, one to read
the ToC. On the free Anthropic tier those huge calls hit the rate limit and failed, so
the textbook was abandoned (the rest of the course finished fine).

**v19 fixes the root cause — the model never receives the whole book:**
- **Page count comes from the PDF bytes, not the AI:** a range-capped fetch reads the
  PDF structure and counts pages (`/Count` + `/Type/Page`). Unit-tested on a real
  37-page PDF → 37, zero tokens. If it still can't tell, it assumes a large book and
  continues instead of failing.
- **Chapter planning runs over OCR'd front matter only:** the first ~20 pages are OCR'd
  by page-range (small, cheap), then the planner reads that TEXT — the 17MB document is
  never sent to the planner.
- **Chapter reading** stays as before: only the relevant chapters' page-ranges, OCR'd
  by URL in ≤8-page windows, capped at `TEXTBOOK_MAX_PAGES` (80).
- **No dead-ends:** if the ToC can't be matched, it reads a representative sample
  instead of parking the file; a ToC-read failure re-queues for the next beat rather
  than abandoning the textbook.

**To re-run the textbook on your existing course:** after deploying v19, re-queue it:
```sql
update source_files set is_textbook = true, read_status = 'pending', page_count = null, chapter_plan = null
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';

insert into onboarding_jobs (run_id, stage, file_id, chunk_index, status)
select run_id, 'textbook', id, 0, 'queued' from source_files
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';
```
Then run the local runner (or `?tick=1`). Ping: `v19-textbook2`.

---

## v20-slice — THE textbook root cause: Anthropic's hard 100-page PDF limit

**The real error, finally identified:** the 400 was
`invalid_request_error: "A maximum of 100 PDF pages may be provided."` — a documented,
hard Anthropic API limit (max 100 pages / 32MB per PDF request). Sending a `document`
URL/base64 that points at the ~970-page solution manual is rejected **no matter which
pages the prompt asks for** — the API loads the whole file and counts its pages. This
is why every prior URL-based attempt failed at this exact step, while the <100-page
scanned papers OCR'd fine.

**The fix (the only one that works):** the worker now **slices the PDF itself** before
sending. `sliceTextbookPages()` fetches the book, uses pdf-lib to extract just the
requested page range into a small (<100-page, hard-capped) PDF, and sends THAT as
base64. Applied to both the table-of-contents read and each chapter window. Proven with
a real test: a 120-page PDF sliced to a valid 8-page, 2.3KB PDF.

So the flow is now: count pages from bytes (no AI) → slice & OCR front matter → pick
relevant chapters → slice & OCR each chapter window (≤8 pages, capped at 80 total) →
understand → attach to topics. Nothing over 100 pages is ever sent.

**Re-run on your course** (after deploying v20, confirm ping shows `v20-slice`):
```sql
update source_files set is_textbook = true, read_status = 'pending', page_count = null, chapter_plan = null, note = null
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';
insert into onboarding_jobs (run_id, stage, file_id, chunk_index, status)
select run_id, 'textbook', id, 0, 'queued' from source_files
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';
```
Then run the local runner / `?tick=1`.

Note: slicing fetches the book per invocation, so textbook windows process one per beat
(memory-safe). It's a bit slower but completes. Ping: `v20-slice`.

---

## v21-texttb — textbook done right: extract TEXT, pick chapters by content

**Two things your screenshots + the actual file revealed:**
1. The previous run hit the FALLBACK ("Sampled pages" 1–100) because the book has **no
   table of contents** — page 1 is a copyright notice, page 2 is "Chapter 1, Problem 1".
   So the ToC-based planner found nothing and sampled from the front = wrong chapters.
2. The solution manual is **1,972 pages but fully TEXT (not scanned).** So OCR and the
   100-page document API were never needed for it at all.

**v21 detects this and does the right thing:**
- Extracts the PDF **text** directly (unpdf) — free, no API, no page limit.
- If the file is text (most are), finds chapter boundaries from the **"Chapter N"**
  labels in the text (verified on your real book: all 19 chapters located with correct
  page ranges).
- Sends the AI a **boilerplate-stripped multi-page sample of each chapter** and asks
  which chapter NUMBERS match the course. On your book this cleanly selects the EEG 322
  chapters (sinusoids, AC analysis, AC power, transfer functions, Laplace, Laplace
  circuits, Fourier series, Fourier transform) — not chapters 1–3.
- Saves ONLY those chapters' text (capped at `TEXTBOOK_MAX_PAGES`, now 300) and runs it
  through understand → topics, with page refs.
- Scanned textbooks (no extractable text) still fall back to the v20 sliced-PDF OCR path.

**Re-run on your course** (deploy v21, confirm ping `v21-texttb`):
```sql
update source_files set is_textbook = true, read_status = 'pending', page_count = null, chapter_plan = null, note = null, text_path = null
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';
insert into onboarding_jobs (run_id, stage, file_id, chunk_index, status)
select run_id, 'textbook', id, 0, 'queued' from source_files
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';
```
Then run the local runner / `?tick=1`. The textbook re-reads with the correct chapters.
Ping: `v21-texttb`.

---

## v22-batchtb — textbook stuck in "Scanning…" loop: full-book parse was too heavy

**Why v21 looped:** extracting text from the whole 1,972-page PDF in one beat took ~25s
/ ~124MB+ — over the Edge Function budget — so the function died mid-parse every time,
the job was reclaimed, and "Scanning… for relevant chapters" repeated forever.

**v22 makes the textbook path batched + self-chaining (memory-safe):**
- **Scan phase:** the book is parsed in `TB_SCAN_BATCH` (120) page slices per beat —
  each beat slices a small PDF (pdf-lib) and extracts text (unpdf), accumulating
  "Chapter N" start pages into `chapter_plan`, chaining to the next batch. Verified the
  batched scan finds all 19 chapters of your real book, identical to a whole-book scan.
- **Classify:** once scanned, samples each chapter (small slices) and asks which chapter
  numbers match the course.
- **Read phase:** reads only the chosen chapters, again in 120-page batches per beat,
  appending text to storage, capped at `TEXTBOOK_MAX_PAGES` (300).
- No beat ever loads the whole book; nothing over 100 pages is sent to any API. Scanned
  textbooks still fall back to sliced-PDF OCR.

Progress is now visible as "Scanning … X/1972 pages" then "Reading … Ch N p.A-B".

**Re-run** (deploy v22, confirm ping `v22-batchtb`):
```sql
update source_files set is_textbook = true, read_status = 'pending', page_count = null, chapter_plan = null, note = null, text_path = null
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';
insert into onboarding_jobs (run_id, stage, file_id, chunk_index, status)
select run_id, 'textbook', id, 0, 'queued' from source_files
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';
```
Then run the local runner / `?tick=1`. Ping: `v22-batchtb`.

---

## v23-cache — textbook: extract ONCE to cache, then plan & read (no rework, no re-download)

**Why v22 still failed (from your log):** the batched scan re-downloaded the whole 17MB
book and re-sliced it EVERY beat — 16+ times. The end batches got slow, a couple of
beats timed out, the per-job attempt counter hit 7, and the circuit breaker killed it at
~1560/1972. The progress counter proved the approach worked; the re-download made it too
slow to finish inside the attempt budget.

**v23 fixes the root inefficiency — the book is parsed exactly once:**
- **Phase "cache":** each beat downloads the book once, extracts a `TB_CACHE_BATCH`
  (250) page slice, and APPENDS the page text to a cache file
  (`tbcache/{run}/{file}.jsonl`). Progress is persisted, so a retry never redoes a
  completed batch. ~8 beats for a 1,972-page book.
- **Phase "plan":** loads the cache (cheap ~2MB read), finds chapter starts from
  "Chapter N" labels, samples each chapter, asks which chapter numbers match the course.
- **Phase "read":** copies ONLY the chosen chapters' text from the cache into the final
  text file (capped `TEXTBOOK_MAX_PAGES`, 300), then deletes the cache.
- Scanned books (little extractable text) fall back to OCR.

**Validated twice before shipping:**
1. Offline simulation against your REAL 1,972-page book: completes in **9 beats**,
   slowest beat **3.6s**, finds all 19 chapters, selects the correct 8
   (Ch 9,10,11,14,15,16,17,18 — sinusoids, AC analysis, AC power, transfer functions,
   Laplace, Laplace circuits, Fourier series, Fourier transform), keeps 300 pages.
2. Real-Deno test of the extract→cache→detect chain on a generated multi-chapter PDF:
   correctly recovered `[1,2,9,15,17]` from cache. **PASS.**

**Re-run** (deploy v23, confirm ping `v23-cache`):
```sql
update source_files set is_textbook = true, read_status = 'pending', page_count = null, chapter_plan = null, note = null, text_path = null
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';
insert into onboarding_jobs (run_id, stage, file_id, chunk_index, status)
select run_id, 'textbook', id, 0, 'queued' from source_files
where course_id in (select id from courses where title = 'Circuits and Systems II')
  and original_path ilike '%Fundamentals%';
```
Then run the local runner / `?tick=1`. You'll see "Reading … X/1972 pages" advance once,
then "Read (textbook): … Ch 9, Ch 15, Ch 17…". Ping: `v23-cache`.

---

## v24-toc (cont.) — uploads survive leaving the new-course page

**The real fix (not just a warning):** the new-course page used to upload files first and
create the course only afterward — so leaving mid-upload lost everything. Now:
1. The course + run are created FIRST (status "building") and appear in your list
   immediately.
2. Files upload into that already-existing course.
3. Onboarding starts (`/api/courses/begin`) once uploads finish.

So if you navigate away, the course is already saved — it shows as "building" in your
courses list instead of disappearing. (New endpoint: `/api/courses/begin`; build shows
19 routes.)

Honest limit: the actual file *transfer* runs in your browser tab, so closing the tab
mid-transfer still can't finish those bytes — but the course no longer vanishes, and a
follow-up will add a "resume upload" affordance on the building-course page. Within-app
navigation while the tab stays open is fully safe.
