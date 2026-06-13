-- =============================================================
-- Study OS · Textbook chapter-selective ingestion
-- Run in the Supabase SQL editor AFTER 0016.
-- =============================================================

-- New pipeline stage: handle a big textbook by reading only the relevant chapters.
alter type public.onboarding_stage add value if not exists 'textbook';

-- Mark which source files are textbooks being handled chapter-selectively.
alter table public.source_files add column if not exists is_textbook boolean not null default false;

-- A scratch column for the textbook stage to remember which chapters it picked
-- and how far through OCR it has progressed (so it can self-chain across invocations).
alter table public.source_files add column if not exists chapter_plan jsonb;
