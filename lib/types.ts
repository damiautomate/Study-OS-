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
  created_at: string;
}
