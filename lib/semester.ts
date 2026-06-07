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
