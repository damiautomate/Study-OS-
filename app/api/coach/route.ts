import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const { courseId, topicId, mode, questionId } = await req.json();
    if (!courseId || !topicId || !mode) return NextResponse.json({ error: "missing fields" }, { status: 400 });

    const supabase = await createServerSupabase();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/agent-coach`, {
      method: "POST",
      headers: {
        "x-worker-secret": process.env.WORKER_SECRET!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode, course_id: courseId, topic_id: topicId, user_id: auth.user.id, question_id: questionId ?? null }),
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
