-- =============================================================
-- Study OS · Slice 5 (Question Bank) · schema additions
-- Run in the Supabase SQL editor AFTER 0004.
-- =============================================================

alter type onboarding_stage add value if not exists 'questions';

create table if not exists public.questions (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  source_file_id  uuid references public.source_files(id) on delete cascade,
  topic_id        uuid references public.course_topics(id) on delete set null,
  question_text   text not null,
  q_type          text,          -- mcq | short | essay | numerical | proof | other
  difficulty      text,          -- easy | medium | hard | null
  has_solution    boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists idx_questions_course on public.questions(course_id);
create index if not exists idx_questions_topic  on public.questions(topic_id);

alter table public.questions enable row level security;

drop policy if exists questions_owner on public.questions;
create policy questions_owner on public.questions
  for select using (exists (select 1 from public.courses c where c.id = course_id and c.user_id = auth.uid()));

do $$ begin
  alter publication supabase_realtime add table public.questions;
exception when duplicate_object then null; end $$;
