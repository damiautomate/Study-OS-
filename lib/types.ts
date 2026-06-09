export type RunStatus = "queued" | "running" | "done" | "failed";
export type Stage = "extract" | "read" | "done";
export type FileReadStatus = "pending" | "read" | "needs_ocr" | "failed" | "duplicate";

export interface Course {
  id: string;
  user_id: string;
  title: string;
  code: string | null;
  semester_start: string;
  test_window: string | null;
  exam_window: string | null;
  test_date: string | null;
  exam_date: string | null;
  weight: number;
  free_choice: boolean;
  target_date: string | null;
  target_goal: string | null;
  status: string;
  created_at: string;
}

export interface OnboardingRun {
  id: string;
  course_id: string;
  zip_path: string;
  stage: Stage;
  status: RunStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceFile {
  id: string;
  course_id: string;
  run_id: string;
  original_path: string;
  storage_path: string | null;
  content_hash: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  page_count: number | null;
  read_status: FileReadStatus;
  text_path: string | null;
  note: string | null;
  category: string | null;
  category_confidence: number | null;
  summary: string | null;
  contains_questions: boolean | null;
  topics: { title: string }[] | null;
  created_at: string;
}

export interface RunEvent {
  id: number;
  run_id: string;
  ts: string;
  kind: "info" | "success" | "warning" | "error" | "stage";
  message: string;
  data: unknown;
}

export interface CourseTopic {
  id: string;
  course_id: string;
  parent_id: string | null;
  level: number;
  order_index: number;
  title: string;
  source_file_ids: string[] | null;
  source_count: number;
  question_count: number;
  created_at: string;
}

export interface Question {
  id: string;
  course_id: string;
  source_file_id: string | null;
  topic_id: string | null;
  question_text: string;
  q_type: string | null;
  difficulty: string | null;
  has_solution: boolean;
  solution_text: string | null;
  created_at: string;
}

export interface StudentProfile {
  id: string;
  user_id: string;
  study_hours_per_day: number | null;
  study_days_per_week: number;
  semester_goal: string | null;
  motivation: string | null;
  past_struggles: string[] | null;
  accountability_style: string | null;
  created_at: string;
  updated_at: string;
}

export interface StudentMastery {
  id: string;
  user_id: string;
  course_id: string;
  topic_id: string;
  reading_state: "not_started" | "in_progress" | "read";
  understanding_state: "unknown" | "shaky" | "developing" | "solid";
  attempts: number;
  last_score: number | null;
  last_touched: string | null;
  created_at: string;
}

export interface StudyPlan {
  id: string;
  user_id: string;
  course_id: string;
  horizon: string;
  situation: string | null;
  active: boolean;
  created_at: string;
}

export interface PlanItem {
  id: string;
  plan_id: string;
  topic_id: string | null;
  order_index: number;
  reason: string | null;
  done: boolean;
}

export interface AgentMessage {
  id: string;
  user_id: string;
  course_id: string | null;
  kind: string;
  body: string;
  created_at: string;
}

export interface Coaching {
  id: string;
  user_id: string;
  course_id: string | null;
  topic_id: string | null;
  question_id: string | null;
  mode: "explain" | "practice" | "hook" | "check";
  body: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export interface ApplicationNote {
  id: string;
  user_id: string;
  course_id: string | null;
  topic_id: string | null;
  why: string | null;
  uses: string[] | null;
  sources: { title: string; url: string }[] | null;
  cross_links: { course: string; topic: string; link: string }[] | null;
  depth: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleItem {
  id: string;
  user_id: string;
  course_id: string;
  topic_id: string | null;
  week_index: number;
  week_start: string;
  week_end: string;
  kind: "learn" | "revise";
  order_index: number;
  done: boolean;
  created_at: string;
}

export interface Capstone {
  id: string;
  user_id: string;
  course_id: string | null;
  title: string;
  kind: "project" | "paper";
  summary: string | null;
  status: "proposed" | "active" | "done";
  created_at: string;
  updated_at: string;
}

export interface CapstoneMilestone {
  id: string;
  user_id: string;
  capstone_id: string;
  order_index: number;
  title: string;
  detail: string | null;
  required_topic_ids: string[] | null;
  done: boolean;
  created_at: string;
}
