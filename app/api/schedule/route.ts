import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { mondayOf, todayISO, daysBetween, addDaysISO, effectiveDates } from "@/lib/semester";

const HRS_PER_TOPIC = 1.5;

function chunkInto<T>(arr: T[], n: number): T[][] {
  if (n <= 0) return [];
  const out: T[][] = [];
  const per = Math.ceil(arr.length / n) || 1;
  for (let i = 0; i < n; i++) out.push(arr.slice(i * per, (i + 1) * per));
  return out;
}

export async function POST(req: Request) {
  try {
    const { courseId } = await req.json();
    if (!courseId) return NextResponse.json({ error: "missing courseId" }, { status: 400 });

    const supabase = await createServerSupabase();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    const { data: course } = await supabase
      .from("courses")
      .select("id, semester_start, test_date, exam_date, test_window, exam_window")
      .eq("id", courseId).maybeSingle();
    if (!course) return NextResponse.json({ error: "course not found" }, { status: 404 });

    const { data: profile } = await supabase
      .from("student_profile").select("study_hours_per_day, study_days_per_week").maybeSingle();

    // ----- ordered topic list (module order, then topic order) -----
    const { data: allTopics } = await supabase
      .from("course_topics").select("id, parent_id, level, order_index, title").eq("course_id", courseId);
    const modOrder = new Map((allTopics ?? []).filter((t) => t.level === 1).map((m) => [m.id, m.order_index ?? 0]));
    let topics = (allTopics ?? []).filter((t) => t.level === 2)
      .sort((a, b) => (modOrder.get(a.parent_id) ?? 0) - (modOrder.get(b.parent_id) ?? 0) || (a.order_index ?? 0) - (b.order_index ?? 0));
    if (topics.length === 0) topics = (allTopics ?? []).filter((t) => t.level === 1).sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    if (topics.length === 0) return NextResponse.json({ error: "no topics to schedule" }, { status: 400 });

    // ----- skip already-mastered topics when learning (re-plan compresses) -----
    const { data: ms } = await supabase.from("student_mastery").select("topic_id, understanding_state").eq("course_id", courseId);
    const solid = new Set((ms ?? []).filter((m) => m.understanding_state === "solid").map((m) => m.topic_id));
    const learnTopics = topics.filter((t) => !solid.has(t.id));

    // ----- weeks from now until the exam, with a revision buffer reserved -----
    const { examDate, testDate } = effectiveDates(course);
    const startMonday = mondayOf(todayISO());
    const deadline = examDate ?? addDaysISO(course.semester_start, 13 * 7);
    let totalWeeks = Math.max(1, Math.floor(daysBetween(startMonday, mondayOf(deadline)) / 7) + 1);
    totalWeeks = Math.min(totalWeeks, 26);
    let bufferWeeks = totalWeeks <= 1 ? 0 : totalWeeks <= 4 ? 1 : 2;
    let learningWeeks = totalWeeks - bufferWeeks;
    if (learnTopics.length === 0) { learningWeeks = 0; bufferWeeks = totalWeeks; } // all learned → all revision
    if (learningWeeks < 0) learningWeeks = 0;

    const weekStartOf = (w: number) => addDaysISO(startMonday, (w - 1) * 7);
    const weekEndOf = (w: number) => addDaysISO(startMonday, (w - 1) * 7 + 6);

    const rows: any[] = [];
    const learnChunks = chunkInto(learnTopics, learningWeeks);
    for (let w = 1; w <= learningWeeks; w++) {
      (learnChunks[w - 1] ?? []).forEach((t, idx) =>
        rows.push({ course_id: courseId, topic_id: t.id, week_index: w, week_start: weekStartOf(w), week_end: weekEndOf(w), kind: "learn", order_index: idx }));
    }
    const reviseCount = totalWeeks - learningWeeks;
    if (reviseCount >= 1) {
      const rChunks = chunkInto(topics, reviseCount); // revise the whole course
      for (let i = 0; i < reviseCount; i++) {
        const w = learningWeeks + 1 + i;
        (rChunks[i] ?? []).forEach((t, idx) =>
          rows.push({ course_id: courseId, topic_id: t.id, week_index: w, week_start: weekStartOf(w), week_end: weekEndOf(w), kind: "revise", order_index: idx }));
      }
    }

    // ----- persist (regenerate replaces) -----
    await supabase.from("schedule_items").delete().eq("course_id", courseId);
    if (rows.length) await supabase.from("schedule_items").insert(rows.slice(0, 800));

    const hoursPerDay = profile?.study_hours_per_day ?? 2;
    const daysPerWeek = profile?.study_days_per_week ?? 5;
    const capacityPerWeek = Math.round(hoursPerDay * daysPerWeek * 10) / 10;
    const neededPerWeek = learningWeeks > 0 ? Math.round((learnTopics.length * HRS_PER_TOPIC / learningWeeks) * 10) / 10 : 0;

    return NextResponse.json({
      ok: true,
      totalWeeks, learningWeeks, bufferWeeks,
      deadline, testDate,
      topics: topics.length, learnTopics: learnTopics.length,
      capacityPerWeek, neededPerWeek,
      overCapacity: neededPerWeek > capacityPerWeek,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
