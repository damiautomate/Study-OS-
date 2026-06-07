-- =============================================================
-- Study OS · Slice 4 (Topic Spine) · schema additions
-- Run in the Supabase SQL editor AFTER 0003.
-- =============================================================

alter type onboarding_stage add value if not exists 'spine';

-- the ordered, de-duplicated topic tree for a course (2 levels: module -> topic)
create table if not exists public.course_topics (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  parent_id       uuid references public.course_topics(id) on delete cascade,
  level           int not null default 1,        -- 1 = module, 2 = topic
  order_index     int not null default 0,
  title           text not null,
  source_file_ids jsonb,                          -- which materials cover this topic
  created_at      timestamptz not null default now()
);

create index if not exists idx_topics_course on public.course_topics(course_id, order_index);

alter table public.course_topics enable row level security;

drop policy if exists topics_owner on public.course_topics;
create policy topics_owner on public.course_topics
  for select using (exists (select 1 from public.courses c where c.id = course_id and c.user_id = auth.uid()));

do $$ begin
  alter publication supabase_realtime add table public.course_topics;
exception when duplicate_object then null; end $$;
