import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function POST() {
  try {
    const supabase = await createServerSupabase();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

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

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
