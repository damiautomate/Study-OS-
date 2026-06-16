import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";

// Called by the new-course page AFTER its uploads finish. The course + run were already
// created (status building) so they survive navigation; here we record the uploaded
// files on the run, insert the first extract job, and kick the worker.
export async function POST(req: Request) {
  try {
    const { runId, uploadPaths } = await req.json();
    const files = Array.isArray(uploadPaths) ? uploadPaths.filter((f: any) => f && typeof f.path === "string") : [];
    if (!runId || files.length === 0) return NextResponse.json({ error: "missing fields" }, { status: 400 });

    const supabase = await createServerSupabase();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    // verify the run belongs to a course owned by this user (RLS also enforces this)
    const { data: run, error: rErr } = await supabase
      .from("onboarding_runs").select("id, course_id, status").eq("id", runId).single();
    if (rErr || !run) return NextResponse.json({ error: "run not found" }, { status: 404 });

    // record uploads on the run
    await supabase.from("onboarding_runs").update({ upload_paths: files }).eq("id", runId);

    // insert first job only if one isn't already there (idempotent if /begin is retried)
    const admin = createAdminSupabase();
    const { data: existing } = await admin.from("onboarding_jobs").select("id").eq("run_id", runId).limit(1);
    if (!existing || existing.length === 0) {
      await admin.from("onboarding_jobs").insert({ run_id: runId, stage: "extract" });
    }

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

    return NextResponse.json({ ok: true, courseId: run.course_id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
