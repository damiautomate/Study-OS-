import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const { courseId, topicId, mode, questionId, answer, capstoneId, topic, goal } = await req.json();
    if (!mode) return NextResponse.json({ error: "missing mode" }, { status: 400 });

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
      body: JSON.stringify({
        mode, user_id: auth.user.id,
        course_id: courseId ?? null, topic_id: topicId ?? null,
        question_id: questionId ?? null, answer: answer ?? null,
        capstone_id: capstoneId ?? null, topic: topic ?? null, goal: goal ?? null,
      }),
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
