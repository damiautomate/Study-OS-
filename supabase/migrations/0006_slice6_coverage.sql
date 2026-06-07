-- =============================================================
-- Study OS · Slice 6 (Coverage & Review) · schema additions
-- Run in the Supabase SQL editor AFTER 0005.
-- =============================================================

alter type onboarding_stage add value if not exists 'coverage';

-- per-topic coverage, computed deterministically (no AI)
alter table public.course_topics add column if not exists source_count int not null default 0;
alter table public.course_topics add column if not exists question_count int not null default 0;

-- course.status now uses: onboarding -> review -> onboarded
-- (status is a plain text column, so no enum change needed)
