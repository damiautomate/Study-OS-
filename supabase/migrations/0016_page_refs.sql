-- =============================================================
-- Study OS · Page-level references + textbook chapter relevance
-- Run in the Supabase SQL editor AFTER 0015.
-- =============================================================

-- For textbooks/books: detected chapters with page ranges and course relevance.
-- e.g. [{"title":"Ch 4: Transmission Lines","pages":"118-167","relevant":true}, ...]
alter table public.source_files add column if not exists page_map jsonb;

-- The exact pages of a material that a topic actually uses.
-- pages like "12-18" or "12,14-16"; null = whole file.
-- excerpt_path: lazily-built PDF of just those pages, stored for reuse.
create table if not exists public.material_refs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  course_id    uuid not null references public.courses(id) on delete cascade,
  topic_id     uuid not null references public.course_topics(id) on delete cascade,
  file_id      uuid not null references public.source_files(id) on delete cascade,
  pages        text,
  excerpt_path text,
  created_at   timestamptz not null default now(),
  unique (topic_id, file_id)
);

create index if not exists idx_material_refs_topic on public.material_refs(topic_id);

alter table public.material_refs enable row level security;
drop policy if exists material_refs_owner on public.material_refs;
create policy material_refs_owner on public.material_refs for all using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$ begin alter publication supabase_realtime add table public.material_refs; exception when duplicate_object then null; end $$;
