import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { semesterWindows } from "@/lib/semester";

export async function POST(req: Request) {
  try {
    const { title, code, semesterStart, zipPath, uploadPaths } = await req.json();
    const files = Array.isArray(uploadPaths) ? uploadPaths.filter((f: any) => f && typeof f.path === "string") : [];
    if (!title || !semesterStart || (!zipPath && files.length === 0)) {
      return NextResponse.json({ error: "missing fields" }, { status: 400 });
    }

    const supabase = await createServerSupabase();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    const { test_window, exam_window } = semesterWindows(semesterStart);

    // course (RLS: user_id defaults to auth.uid())
    const { data: course, error: cErr } = await supabase
      .from("courses")
      .insert({ title, code: code || null, semester_start: semesterStart, test_window, exam_window })
      .select("id")
      .single();
    if (cErr || !course) return NextResponse.json({ error: cErr?.message ?? "course failed" }, { status: 500 });

    // run
    const { data: run, error: rErr } = await supabase
      .from("onboarding_runs")
      .insert({ course_id: course.id, zip_path: zipPath ?? null, upload_paths: files.length ? files : null, stage: "extract", status: "queued" })
      .select("id")
      .single();
    if (rErr || !run) {
      // don't leave a ghost course behind — failed attempts were creating duplicates
      await supabase.from("courses").delete().eq("id", course.id);
      return NextResponse.json({ error: rErr?.message ?? "run failed" }, { status: 500 });
    }

    // first job + kick the worker (privileged)
    const admin = createAdminSupabase();
    await admin.from("onboarding_jobs").insert({ run_id: run.id, stage: "extract" });

    // give the kick a moment to actually reach the worker before this function exits
    await Promise.race([
      fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/onboarding-worker`, {
        method: "POST",
        headers: {
          "x-worker-secret": process.env.WORKER_SECRET!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }).catch(() => {}),
      new Promise((r) => setTimeout(r, 1500)),
    ]);

    return NextResponse.json({ courseId: course.id, runId: run.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
