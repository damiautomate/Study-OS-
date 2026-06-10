import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";

export async function POST(req: Request) {
  try {
    const { courseId, files } = await req.json();
    const list = Array.isArray(files) ? files.filter((f: any) => f && typeof f.path === "string") : [];
    if (!courseId || list.length === 0) return NextResponse.json({ error: "missing fields" }, { status: 400 });

    const supabase = await createServerSupabase();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    // RLS: only returns the course if it's yours
    const { data: course } = await supabase.from("courses").select("id, status").eq("id", courseId).maybeSingle();
    if (!course) return NextResponse.json({ error: "course not found" }, { status: 404 });

    const { data: run, error: rErr } = await supabase
      .from("onboarding_runs")
      .insert({ course_id: courseId, kind: "augment", upload_paths: list, stage: "extract", status: "queued" })
      .select("id")
      .single();
    if (rErr || !run) return NextResponse.json({ error: rErr?.message ?? "run failed" }, { status: 500 });

    const admin = createAdminSupabase();
    await admin.from("onboarding_jobs").insert({ run_id: run.id, stage: "extract" });

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

    return NextResponse.json({ runId: run.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
