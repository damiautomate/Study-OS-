import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";

export async function POST(req: Request) {
  try {
    const { fileId } = await req.json();
    if (!fileId) return NextResponse.json({ error: "missing fileId" }, { status: 400 });

    const supabase = await createServerSupabase();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    // RLS: this select only returns the row if the user owns the course it belongs to
    const { data: file } = await supabase
      .from("source_files").select("storage_path").eq("id", fileId).maybeSingle();
    if (!file?.storage_path) return NextResponse.json({ error: "not found" }, { status: 404 });

    const admin = createAdminSupabase();
    const { data: signed, error } = await admin.storage
      .from("course-uploads").createSignedUrl(file.storage_path, 300);
    if (error || !signed) return NextResponse.json({ error: error?.message ?? "could not sign" }, { status: 500 });

    return NextResponse.json({ url: signed.signedUrl });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
