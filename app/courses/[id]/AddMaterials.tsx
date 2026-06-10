"use client";

import { useEffect, useRef, useState } from "react";
import { ensureSession } from "@/lib/supabase/client";

export default function AddMaterials({ courseId, onMerged }: { courseId: string; onMerged?: () => void }) {
  const supaRef = useRef<any>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState("");

  useEffect(() => {
    let channel: any = null;
    (async () => {
      const supabase = await ensureSession();
      supaRef.current = supabase;
      if (!runId) return;
      channel = supabase.channel(`aug-${runId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "run_events", filter: `run_id=eq.${runId}` },
          (p: any) => {
            const msg = p.new?.message ?? "";
            setLastEvent(msg);
            if (String(msg).includes("merged into your course")) {
              setBusy(false); setFiles([]); setRunId(null); setStatus("");
              onMerged?.();
            }
          })
        .subscribe();
    })();
    return () => { if (channel) channel.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  async function submit() {
    setError("");
    if (files.length === 0) return;
    setBusy(true);
    try {
      const supabase = supaRef.current ?? (await ensureSession());
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user!.id;
      const batch = crypto.randomUUID();
      const uploaded: { path: string; name: string }[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus(`Uploading ${i + 1}/${files.length} — ${f.name}…`);
        const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
        const path = `${uid}/aug-${batch}/${i + 1}-${safe}`;
        const up = await supabase.storage.from("course-uploads").upload(path, f, { upsert: false });
        if (up.error) throw new Error(`${f.name}: ${up.error.message}`);
        uploaded.push({ path, name: f.name });
      }
      setStatus("Merging into your course…");
      const res = await fetch("/api/augment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, files: uploaded }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not start the merge.");
      setRunId(json.runId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false); setStatus("");
    }
  }

  return (
    <section className="card rounded-2xl px-5 py-5">
      <h2 className="label mb-1 text-faint">Add materials</h2>
      <p className="mb-3 text-xs text-muted">
        New notes, a textbook chapter, more past questions — drop them in and they&apos;re read,
        merged into your course map, and added to the question bank. Duplicates are skipped.
      </p>

      <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-line bg-ink px-4 py-5 text-center transition hover:border-gold">
        <input type="file" multiple className="hidden"
          accept=".zip,.pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,application/zip,application/pdf,image/*,text/plain,text/csv"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))} disabled={busy} />
        <span className="text-sm text-muted">
          {files.length > 0 ? <span className="text-paper">{files.length === 1 ? files[0].name : `${files.length} files selected`}</span> : "Tap to choose files (PDFs, images, notes, or a .zip)"}
        </span>
      </label>

      {error && <p className="mt-2 text-xs text-rust">{error}</p>}
      {busy && (
        <p className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-gold" />
          {lastEvent || status}
        </p>
      )}

      {files.length > 0 && !busy && (
        <button onClick={submit} className="mt-3 rounded-full bg-gold px-4 py-2 text-sm font-semibold text-ink shadow-sm transition hover:bg-gold-dim">
          Add {files.length === 1 ? "it" : `${files.length} files`} to this course
        </button>
      )}
    </section>
  );
}
