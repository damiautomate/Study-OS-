-- =============================================================
-- Study OS · Agent Slice 3 (Tracking Loop) · schema
-- Run in the Supabase SQL editor AFTER 0008.
-- =============================================================

-- when the student last did anything (drift signal)
alter table public.student_profile add column if not exists last_active_at timestamptz;

-- lightweight activity history (feeds engagement / drift)
create table if not exists public.study_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id   uuid references public.courses(id) on delete cascade,
  topic_id    uuid references public.course_topics(id) on delete set null,
  kind        text,        -- read | practiced | studied
  created_at  timestamptz not null default now()
);

create index if not exists idx_studylog_user on public.study_log(user_id, created_at);

alter table public.study_log enable row level security;
drop policy if exists studylog_owner on public.study_log;
create policy studylog_owner on public.study_log for all using (user_id = auth.uid()) with check (user_id = auth.uid());
