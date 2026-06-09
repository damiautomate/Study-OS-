-- =============================================================
-- Study OS · Phase 7 (Capstone) + Phase 8 (Free course) · schema
-- Run in the Supabase SQL editor AFTER 0013.
-- =============================================================

-- ---------- Phase 7: Capstone ----------
create table if not exists public.capstones (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id   uuid references public.courses(id) on delete cascade,   -- anchor course
  title       text not null,
  kind        text not null default 'project',   -- project | paper
  summary     text,
  status      text not null default 'proposed',  -- proposed | active | done
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.capstone_milestones (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  capstone_id        uuid not null references public.capstones(id) on delete cascade,
  order_index        int not null default 0,
  title              text not null,
  detail             text,
  required_topic_ids jsonb,        -- topic ids that must be 'solid' before this unlocks
  done               boolean not null default false,
  created_at         timestamptz not null default now()
);
create index if not exists idx_milestones_capstone on public.capstone_milestones(capstone_id, order_index);

alter table public.capstones enable row level security;
alter table public.capstone_milestones enable row level security;
drop policy if exists capstones_owner on public.capstones;
create policy capstones_owner on public.capstones for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists milestones_owner on public.capstone_milestones;
create policy milestones_owner on public.capstone_milestones for all using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$ begin alter publication supabase_realtime add table public.capstones; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.capstone_milestones; exception when duplicate_object then null; end $$;

-- ---------- Phase 8: Free-choice course ----------
alter table public.courses add column if not exists free_choice boolean not null default false;
alter table public.courses add column if not exists target_date date;     -- self-set goal date (no exam calendar)
alter table public.courses add column if not exists target_goal text;
