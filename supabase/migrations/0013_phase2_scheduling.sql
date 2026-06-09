-- =============================================================
-- Study OS · Phase 2 (Planning & Scheduling) · schema
-- Run in the Supabase SQL editor AFTER 0012.
-- =============================================================

-- Student-editable assessment dates (school dates shift) + relative weight.
-- These OVERRIDE the computed windows when set; urgency + scheduling prefer them.
alter table public.courses add column if not exists test_date  date;
alter table public.courses add column if not exists exam_date  date;
alter table public.courses add column if not exists weight     smallint not null default 3;  -- 1..5 importance/difficulty

-- Study capacity: hours/day already on student_profile; add days/week.
alter table public.student_profile add column if not exists study_days_per_week smallint not null default 5;

-- The generated, deadline-aware schedule. Deterministic; regenerating replaces.
-- One row per (topic, week) occurrence, with a phase: learn first, then revise.
create table if not exists public.schedule_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id    uuid not null references public.courses(id) on delete cascade,
  topic_id     uuid references public.course_topics(id) on delete cascade,
  week_index   int not null,            -- 1 = current week
  week_start   date not null,
  week_end     date not null,
  kind         text not null,           -- learn | revise
  order_index  int not null default 0,
  done         boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists idx_schedule_course on public.schedule_items(user_id, course_id, week_index, order_index);

alter table public.schedule_items enable row level security;
drop policy if exists schedule_owner on public.schedule_items;
create policy schedule_owner on public.schedule_items for all using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$ begin alter publication supabase_realtime add table public.schedule_items; exception when duplicate_object then null; end $$;
