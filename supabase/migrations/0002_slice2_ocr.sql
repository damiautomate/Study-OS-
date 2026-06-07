-- =============================================================
-- Study OS · Slice 2 (OCR) · schema additions
-- Run in the Supabase SQL editor AFTER 0001.
-- =============================================================

-- new pipeline stage + file outcomes
alter type onboarding_stage add value if not exists 'ocr';
alter type file_read_status add value if not exists 'ocr_failed';
alter type file_read_status add value if not exists 'partial';
alter type file_read_status add value if not exists 'unsupported';

-- chunk pointer for large PDFs split across beats
alter table public.onboarding_jobs add column if not exists chunk_index int;

-- per-call AI usage, so a course's cost is visible
create table if not exists public.ai_usage (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid references public.onboarding_runs(id) on delete cascade,
  file_id        uuid references public.source_files(id) on delete cascade,
  stage          text,
  model          text,
  input_tokens   int,
  output_tokens  int,
  created_at     timestamptz not null default now()
);

create index if not exists idx_ai_usage_run on public.ai_usage(run_id);

alter table public.ai_usage enable row level security;

drop policy if exists ai_usage_owner on public.ai_usage;
create policy ai_usage_owner on public.ai_usage
  for select using (exists (
    select 1 from public.onboarding_runs r
    join public.courses c on c.id = r.course_id
    where r.id = run_id and c.user_id = auth.uid()
  ));
