// Semester model (fixed): 14 weeks. Tests in weeks 5-7, exams in weeks 12-13.
// Returns Postgres daterange literals, e.g. "[2026-02-02,2026-02-23)".

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekStart(semesterStart: string, week: number): string {
  return addDays(semesterStart, (week - 1) * 7);
}

export function semesterWindows(semesterStart: string): {
  test_window: string;
  exam_window: string;
} {
  // test: start of week 5 -> start of week 8 (exclusive)
  const test_window = `[${weekStart(semesterStart, 5)},${weekStart(semesterStart, 8)})`;
  // exam: start of week 12 -> start of week 14 (exclusive)
  const exam_window = `[${weekStart(semesterStart, 12)},${weekStart(semesterStart, 14)})`;
  return { test_window, exam_window };
}

// human-readable summary for the UI
export function describeWindows(semesterStart: string): { tests: string; exams: string } {
  const fmt = (iso: string) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return {
    tests: `${fmt(weekStart(semesterStart, 5))} – ${fmt(weekStart(semesterStart, 7) + "")}`,
    exams: `${fmt(weekStart(semesterStart, 12))} – ${fmt(weekStart(semesterStart, 13))}`,
  };
}

// ---- Phase 2 scheduling helpers ----

// Monday (UTC) of the week containing `iso` (YYYY-MM-DD).
export function mondayOf(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(aISO: string, bISO: string): number {
  const a = new Date(aISO + "T00:00:00Z").getTime();
  const b = new Date(bISO + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

// Lower bound date of a Postgres daterange literal like "[2026-02-02,2026-02-23)".
export function rangeStart(range: string | null): string | null {
  if (!range) return null;
  const m = range.match(/[\[(]\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// The deadline dates a course actually uses: explicit date wins, else window start.
export function effectiveDates(course: {
  test_date?: string | null; exam_date?: string | null;
  test_window?: string | null; exam_window?: string | null;
  target_date?: string | null;
}): { testDate: string | null; examDate: string | null } {
  return {
    testDate: course.test_date ?? rangeStart(course.test_window ?? null),
    examDate: course.exam_date ?? rangeStart(course.exam_window ?? null) ?? course.target_date ?? null,
  };
}

export function addDaysISO(iso: string, days: number): string {
  return addDays(iso, days);
}
