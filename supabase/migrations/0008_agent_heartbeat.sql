-- =============================================================
-- Study OS · Agent Slice 2 (Heartbeat) · schema
-- Run in the Supabase SQL editor AFTER 0007.
-- =============================================================

-- the agent's current study plan for a course
create table if not exists public.study_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  horizon     text not null default 'week',
  situation   text,                  -- the agent's read of where things stand
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.plan_items (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references public.study_plans(id) on delete cascade,
  topic_id     uuid references public.course_topics(id) on delete set null,
  order_index  int  not null default 0,
  reason       text,
  done         boolean not null default false
);

-- messages / nudges the agent sends the student
create table if not exists public.agent_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id   uuid references public.courses(id) on delete cascade,
  kind        text not null default 'note',
  body        text not null,
  created_at  timestamptz not null default now()
);

-- audit log of every action the agent emits (incl. hold)
create table if not exists public.agent_actions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,
  course_id   uuid references public.courses(id) on delete cascade,
  type        text not null,
  rationale   text,
  payload     jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_plans_course   on public.study_plans(course_id, active);
create index if not exists idx_planitems_plan  on public.plan_items(plan_id, order_index);
create index if not exists idx_msgs_course      on public.agent_messages(course_id, created_at);

alter table public.study_plans    enable row level security;
alter table public.plan_items     enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_actions  enable row level security;

drop policy if exists plans_owner on public.study_plans;
create policy plans_owner on public.study_plans for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists planitems_owner on public.plan_items;
create policy planitems_owner on public.plan_items for all
  using (exists (select 1 from public.study_plans p where p.id = plan_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.study_plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists msgs_owner on public.agent_messages;
create policy msgs_owner on public.agent_messages for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists actions_owner on public.agent_actions;
create policy actions_owner on public.agent_actions for select using (user_id = auth.uid());

do $$ begin alter publication supabase_realtime add table public.study_plans; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.plan_items; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.agent_messages; exception when duplicate_object then null; end $$;
