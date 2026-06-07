-- =============================================================
-- Study OS · Slice 1 (Ingest & Inventory) · schema
-- Run this in the Supabase SQL editor.
-- =============================================================

-- ---------- enums ----------
do $$ begin
  create type onboarding_stage as enum ('extract', 'read', 'done');
exception when duplicate_object then null; end $$;

do $$ begin
  create type run_status as enum ('queued', 'running', 'done', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type file_read_status as enum ('pending', 'read', 'needs_ocr', 'failed', 'duplicate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_status as enum ('queued', 'processing', 'done', 'failed');
exception when duplicate_object then null; end $$;

-- ---------- courses ----------
create table if not exists public.courses (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title           text not null,
  code            text,
  semester_start  date not null,
  test_window     daterange,
  exam_window     daterange,
  status          text not null default 'onboarding',  -- onboarding | onboarded
  created_at      timestamptz not null default now()
);

-- ---------- onboarding runs ----------
create table if not exists public.onboarding_runs (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses(id) on delete cascade,
  zip_path    text not null,            -- storage path of the uploaded zip
  stage       onboarding_stage not null default 'extract',
  status      run_status not null default 'queued',
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- source files (the inventory) ----------
create table if not exists public.source_files (
  id             uuid primary key default gen_random_uuid(),
  course_id      uuid not null references public.courses(id) on delete cascade,
  run_id         uuid not null references public.onboarding_runs(id) on delete cascade,
  original_path  text not null,         -- path inside the zip
  storage_path   text,                  -- extracted file in storage
  content_hash   text,
  mime_type      text,
  size_bytes     bigint,
  page_count     int,
  read_status    file_read_status not null default 'pending',
  text_path      text,                  -- storage path of extracted text
  note           text,
  created_at     timestamptz not null default now()
);

-- ---------- live progress feed ----------
create table if not exists public.run_events (
  id        bigint generated always as identity primary key,
  run_id    uuid not null references public.onboarding_runs(id) on delete cascade,
  ts        timestamptz not null default now(),
  kind      text not null default 'info',  -- info | success | warning | error | stage
  message   text not null,
  data      jsonb
);

-- ---------- job queue (plain table + SKIP LOCKED) ----------
create table if not exists public.onboarding_jobs (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.onboarding_runs(id) on delete cascade,
  stage       onboarding_stage not null,
  file_id     uuid references public.source_files(id) on delete cascade, -- for 'read' jobs
  attempts    int not null default 0,
  status      job_status not null default 'queued',
  locked_at   timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------- indexes ----------
create index if not exists idx_runs_course       on public.onboarding_runs(course_id);
create index if not exists idx_files_run         on public.source_files(run_id);
create index if not exists idx_files_course       on public.source_files(course_id);
create index if not exists idx_events_run         on public.run_events(run_id, ts);
create index if not exists idx_jobs_pickup        on public.onboarding_jobs(status, created_at);

-- =============================================================
-- Atomic job claim: one queued job, locked, no double-processing
-- =============================================================
create or replace function public.claim_onboarding_job()
returns public.onboarding_jobs
language plpgsql
security definer
set search_path = public
as $$
declare j public.onboarding_jobs;
begin
  select * into j
  from public.onboarding_jobs
  where status = 'queued'
     or (status = 'processing' and locked_at < now() - interval '120 seconds')
  order by created_at
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.onboarding_jobs
    set status = 'processing', locked_at = now(), attempts = attempts + 1
  where id = j.id
  returning * into j;

  return j;
end;
$$;

-- =============================================================
-- Row Level Security
-- Users touch only their own courses + descendants.
-- The worker uses the service role, which bypasses RLS.
-- =============================================================
alter table public.courses        enable row level security;
alter table public.onboarding_runs enable row level security;
alter table public.source_files   enable row level security;
alter table public.run_events     enable row level security;
alter table public.onboarding_jobs enable row level security;

-- courses
drop policy if exists courses_owner on public.courses;
create policy courses_owner on public.courses
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- helper predicate: a run/file belongs to a course the user owns
drop policy if exists runs_owner on public.onboarding_runs;
create policy runs_owner on public.onboarding_runs
  for all using (exists (select 1 from public.courses c where c.id = course_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.courses c where c.id = course_id and c.user_id = auth.uid()));

drop policy if exists files_owner on public.source_files;
create policy files_owner on public.source_files
  for select using (exists (select 1 from public.courses c where c.id = course_id and c.user_id = auth.uid()));

drop policy if exists events_owner on public.run_events;
create policy events_owner on public.run_events
  for select using (exists (
    select 1 from public.onboarding_runs r
    join public.courses c on c.id = r.course_id
    where r.id = run_id and c.user_id = auth.uid()
  ));

-- jobs table: no client access at all (worker only, via service role)
drop policy if exists jobs_none on public.onboarding_jobs;
create policy jobs_none on public.onboarding_jobs for select using (false);

-- =============================================================
-- Realtime: clients subscribe to the live feed + inventory
-- =============================================================
do $$ begin
  alter publication supabase_realtime add table public.run_events;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.source_files;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.onboarding_runs;
exception when duplicate_object then null; end $$;

-- =============================================================
-- Storage: private bucket for uploads + extracted artifacts
-- =============================================================
insert into storage.buckets (id, name, public)
values ('course-uploads', 'course-uploads', false)
on conflict (id) do nothing;

-- A user may upload/read only inside their own top-level folder ({uid}/...).
-- The worker uses the service role, which bypasses these and handles
-- the extracted/ and text/ paths.
drop policy if exists "own uploads insert" on storage.objects;
create policy "own uploads insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'course-uploads' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own uploads read" on storage.objects;
create policy "own uploads read" on storage.objects
  for select to authenticated
  using (bucket_id = 'course-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
