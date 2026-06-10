import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";

const BUCKET = "course-uploads";
const MAX_PACK_PAGES = 120;

// "12-18,21" -> sorted unique page numbers (1-based)
function parsePages(spec: string | null): number[] | null {
  if (!spec) return null;
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = a; i <= Math.min(b, a + 400); i++) out.add(i);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

async function appendPages(out: PDFDocument, srcBytes: Uint8Array, pages: number[] | null, capLeft: number): Promise<number> {
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  let wanted = pages ? pages.filter((p) => p >= 1 && p <= total).map((p) => p - 1) : Array.from({ length: total }, (_, i) => i);
  if (!pages && total > 15) wanted = wanted.slice(0, 15); // whole-file ref on a big doc: keep it sane
  wanted = wanted.slice(0, capLeft);
  if (wanted.length === 0) return 0;
  const copied = await out.copyPages(src, wanted);
  copied.forEach((p) => out.addPage(p));
  return wanted.length;
}

export async function POST(req: Request) {
  try {
    const { refId, topicId } = await req.json();
    if (!refId && !topicId) return NextResponse.json({ error: "missing refId or topicId" }, { status: 400 });

    const supabase = await createServerSupabase();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    const admin = createAdminSupabase();

    // ---------- single reference: the exact pages of one material ----------
    if (refId) {
      // RLS: only returns the row if it's yours
      const { data: ref } = await supabase.from("material_refs").select("*").eq("id", refId).maybeSingle();
      if (!ref) return NextResponse.json({ error: "not found" }, { status: 404 });

      if (ref.excerpt_path) {
        const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(ref.excerpt_path, 300);
        if (signed) return NextResponse.json({ url: signed.signedUrl, cached: true });
      }

      const { data: file } = await supabase.from("source_files").select("storage_path, mime_type").eq("id", ref.file_id).maybeSingle();
      if (!file?.storage_path) return NextResponse.json({ error: "file missing" }, { status: 404 });

      const pages = parsePages(ref.pages);
      // not a PDF, or no specific pages -> just open the whole file
      if (file.mime_type !== "application/pdf" || !pages) {
        const { data: signed, error } = await admin.storage.from(BUCKET).createSignedUrl(file.storage_path, 300);
        if (error || !signed) return NextResponse.json({ error: error?.message ?? "could not sign" }, { status: 500 });
        return NextResponse.json({ url: signed.signedUrl, whole: true });
      }

      const dl = await admin.storage.from(BUCKET).download(file.storage_path);
      if (dl.error || !dl.data) return NextResponse.json({ error: "download failed" }, { status: 500 });
      const out = await PDFDocument.create();
      const added = await appendPages(out, new Uint8Array(await dl.data.arrayBuffer()), pages, MAX_PACK_PAGES);
      if (added === 0) {
        const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(file.storage_path, 300);
        return NextResponse.json({ url: signed?.signedUrl, whole: true });
      }
      const bytes = await out.save();
      const path = `excerpts/${ref.id}.pdf`;
      const up = await admin.storage.from(BUCKET).upload(path, new Uint8Array(bytes), { contentType: "application/pdf", upsert: true });
      if (!up.error) await supabase.from("material_refs").update({ excerpt_path: path }).eq("id", ref.id);
      const { data: signed, error } = await admin.storage.from(BUCKET).createSignedUrl(path, 300);
      if (error || !signed) return NextResponse.json({ error: error?.message ?? "could not sign" }, { status: 500 });
      return NextResponse.json({ url: signed.signedUrl, pages: added });
    }

    // ---------- topic pack: every referenced page for a topic, in one PDF ----------
    const { data: refs } = await supabase.from("material_refs").select("*").eq("topic_id", topicId).limit(10);
    if (!refs || refs.length === 0) return NextResponse.json({ error: "no references for this topic" }, { status: 404 });
    const { data: files } = await supabase.from("source_files").select("id, storage_path, mime_type")
      .in("id", refs.map((r: any) => r.file_id));
    const byId = new Map((files ?? []).map((f: any) => [f.id, f]));

    const out = await PDFDocument.create();
    let added = 0;
    for (const r of refs) {
      if (added >= MAX_PACK_PAGES) break;
      const f = byId.get(r.file_id);
      if (!f?.storage_path || f.mime_type !== "application/pdf") continue;
      const dl = await admin.storage.from(BUCKET).download(f.storage_path);
      if (dl.error || !dl.data) continue;
      added += await appendPages(out, new Uint8Array(await dl.data.arrayBuffer()), parsePages(r.pages), MAX_PACK_PAGES - added);
    }
    if (added === 0) return NextResponse.json({ error: "no PDF pages to pack for this topic" }, { status: 404 });

    const bytes = await out.save();
    const path = `excerpts/topic-${topicId}.pdf`;
    const up = await admin.storage.from(BUCKET).upload(path, new Uint8Array(bytes), { contentType: "application/pdf", upsert: true });
    if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });
    const { data: signed, error } = await admin.storage.from(BUCKET).createSignedUrl(path, 300);
    if (error || !signed) return NextResponse.json({ error: error?.message ?? "could not sign" }, { status: 500 });
    return NextResponse.json({ url: signed.signedUrl, pages: added });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
