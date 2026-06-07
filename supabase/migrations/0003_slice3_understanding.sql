-- =============================================================
-- Study OS · Slice 3 (Understanding) · schema additions
-- Run in the Supabase SQL editor AFTER 0002.
-- =============================================================

alter type onboarding_stage add value if not exists 'understand';

alter table public.source_files add column if not exists category text;
alter table public.source_files add column if not exists category_confidence real;
alter table public.source_files add column if not exists summary text;
alter table public.source_files add column if not exists contains_questions boolean;
alter table public.source_files add column if not exists topics jsonb;
