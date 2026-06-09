-- =============================================================
-- Study OS · Agent Slice 6 (Answer-checking) · schema
-- Run in the Supabase SQL editor AFTER 0010.
-- =============================================================

-- Store the real solution text when it exists in the student's own materials.
-- (Captured by the onboarding questions stage; null when no key was provided.)
alter table public.questions add column if not exists solution_text text;

-- A durable record of every attempt, so the agent can see what was actually
-- tried and missed (not just the latest mastery state).
create table if not exists public.question_attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id    uuid references public.courses(id) on delete cascade,
  topic_id     uuid references public.course_topics(id) on delete set null,
  question_id  uuid references public.questions(id) on delete set null,
  answer       text,
  verdict      text,          -- correct | partial | incorrect
  score        int,           -- 0..100
  graded_on    text,          -- official_solution | materials_only
  created_at   timestamptz not null default now()
);

create index if not exists idx_attempts_topic on public.question_attempts(user_id, topic_id, created_at);

alter table public.question_attempts enable row level security;
drop policy if exists attempts_owner on public.question_attempts;
create policy attempts_owner on public.question_attempts for all using (user_id = auth.uid()) with check (user_id = auth.uid());
