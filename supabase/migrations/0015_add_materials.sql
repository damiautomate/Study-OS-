-- =============================================================
-- Study OS · Multi-file uploads + add-materials-after-onboarding
-- Run in the Supabase SQL editor AFTER 0014.
-- =============================================================

-- New pipeline stage for augment runs: map new files onto the EXISTING spine.
alter type public.onboarding_stage add value if not exists 'assign';

-- Runs can now carry multiple direct uploads (zip optional), and a kind:
--   initial = first onboarding (builds the spine, ends in review)
--   augment = adding materials to an onboarded course (merges into the spine)
alter table public.onboarding_runs alter column zip_path drop not null;
alter table public.onboarding_runs add column if not exists kind text not null default 'initial';
alter table public.onboarding_runs add column if not exists upload_paths jsonb;
