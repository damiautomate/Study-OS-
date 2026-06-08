import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const { courseId } = await req.json();
    if (!courseId) return NextResponse.json({ error: "missing courseId" }, { status: 400 });

    const supabase = await createServerSupabase();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    // fire the heartbeat (don't block the response on the reasoning call)
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/agent-heartbeat`, {
      method: "POST",
      headers: {
        "x-worker-secret": process.env.WORKER_SECRET!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ course_id: courseId, user_id: auth.user.id, reason: "manual" }),
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
