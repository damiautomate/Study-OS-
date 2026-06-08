-- =============================================================
-- Study OS · Agent Slice 4 (Coaching) · schema
-- Run in the Supabase SQL editor AFTER 0009.
-- =============================================================

create table if not exists public.coaching (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id    uuid references public.courses(id) on delete cascade,
  topic_id     uuid references public.course_topics(id) on delete set null,
  question_id  uuid references public.questions(id) on delete set null,
  mode         text not null,        -- explain | practice | hook
  body         text,
  meta         jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_coaching_topic on public.coaching(topic_id, created_at);

alter table public.coaching enable row level security;
drop policy if exists coaching_owner on public.coaching;
create policy coaching_owner on public.coaching for all using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$ begin alter publication supabase_realtime add table public.coaching; exception when duplicate_object then null; end $$;
