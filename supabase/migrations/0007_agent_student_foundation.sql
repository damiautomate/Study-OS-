-- =============================================================
-- Study OS · Agent Slice 1 (Student Foundation) · schema
-- Run in the Supabase SQL editor AFTER 0006.
-- =============================================================

-- ---------- the learner (slow-changing layers) ----------
create table if not exists public.student_profile (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  study_hours_per_day  numeric,
  semester_goal        text,
  motivation           text,            -- what they'd love to build / what excites them
  past_struggles       text[],          -- multi-select
  accountability_style text,            -- gentle | firm | stakes | structure
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.student_profile enable row level security;
drop policy if exists profile_owner on public.student_profile;
create policy profile_owner on public.student_profile
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- per-topic mastery (the fast-changing core) ----------
create table if not exists public.student_mastery (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id           uuid not null references public.courses(id) on delete cascade,
  topic_id            uuid not null references public.course_topics(id) on delete cascade,
  reading_state       text not null default 'not_started',  -- not_started | in_progress | read
  understanding_state text not null default 'unknown',       -- unknown | shaky | developing | solid
  attempts            int  not null default 0,
  last_score          numeric,
  last_touched        timestamptz,
  created_at          timestamptz not null default now(),
  unique (user_id, topic_id)
);

create index if not exists idx_mastery_user   on public.student_mastery(user_id);
create index if not exists idx_mastery_course on public.student_mastery(course_id);

alter table public.student_mastery enable row level security;
drop policy if exists mastery_owner on public.student_mastery;
create policy mastery_owner on public.student_mastery
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$ begin
  alter publication supabase_realtime add table public.student_mastery;
exception when duplicate_object then null; end $$;
