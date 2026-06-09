-- =============================================================
-- Study OS · Phase 6 (Real-World Application) · schema
-- Run in the Supabase SQL editor AFTER 0011.
-- =============================================================

-- One cached, revisitable "why this matters" note per concept.
-- Generated at a checkpoint (when a topic becomes understood) or on demand,
-- then reused — research is not re-run on every view (cost discipline).
create table if not exists public.application_notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id    uuid references public.courses(id) on delete cascade,
  topic_id     uuid references public.course_topics(id) on delete cascade,
  why          text,            -- relevance framing, tied to the student's goal
  uses         jsonb,           -- concrete real-world uses (array of strings)
  sources      jsonb,           -- cited real sources: [{title, url}]
  cross_links  jsonb,           -- genuine cross-course links: [{course, topic, link}]
  depth        jsonb,           -- optional go-deeper pointers (array of strings)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, topic_id)
);

alter table public.application_notes enable row level security;
drop policy if exists application_notes_owner on public.application_notes;
create policy application_notes_owner on public.application_notes for all using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$ begin alter publication supabase_realtime add table public.application_notes; exception when duplicate_object then null; end $$;
