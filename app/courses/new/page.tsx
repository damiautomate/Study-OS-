"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ensureSession } from "@/lib/supabase/client";
import { describeWindows } from "@/lib/semester";
import { uploadWithProgress, checkFileSize } from "@/lib/upload";

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return "Something went wrong."; }
}

export default function NewCourse() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [semesterStart, setSemesterStart] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const windows = semesterStart ? describeWindows(semesterStart) : null;

  async function submit() {
    setError("");
    if (!title.trim() || !semesterStart || files.length === 0) {
      setError("Add a title, a start date, and at least one file.");
      return;
    }
    setBusy(true);
    try {
      const supabase = await ensureSession();
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user!.id;

      for (const f of files) {
        const sizeErr = checkFileSize(f);
        if (sizeErr) throw new Error(sizeErr);
      }
      const batch = crypto.randomUUID();
      const uploaded: { path: string; name: string; size: number; mime: string | null }[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus(`Uploading ${i + 1}/${files.length} — ${f.name}… 0%`);
        const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
        const path = `${uid}/${batch}/${i + 1}-${safe}`;
        await uploadWithProgress(supabase, "course-uploads", path, f,
          (pct) => setStatus(`Uploading ${i + 1}/${files.length} — ${f.name}… ${pct}%`));
        uploaded.push({ path, name: f.name, size: f.size, mime: f.type || null });
      }

      setStatus("Setting things up…");
      const res = await fetch("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), code: code.trim(), semesterStart, uploadPaths: uploaded }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error ?? "Something went wrong."));

      router.push(`/courses/${json.courseId}`);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
      setStatus("");
    }
  }

  return (
    <main className="mx-auto max-w-xl px-5 py-12 sm:py-16">
      <button onClick={() => router.push("/")} className="text-xs text-faint hover:text-muted mb-8">
        ← back
      </button>
      <h1 className="text-3xl sm:text-4xl text-paper mb-2">New course</h1>
      <p className="text-muted mb-10 leading-relaxed">
        Drop in everything for the course — individual PDFs, images, notes, or a .zip (or a mix). Tests are assumed around weeks 5–7,
        exams around weeks 12–13.
      </p>

      <div className="space-y-6">
        <Field label="Course title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Thermodynamics"
            className="input"
          />
        </Field>

        <Field label="Course code (optional)">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. MEE 305" className="input" />
        </Field>

        <Field label="Semester start date">
          <input type="date" value={semesterStart} onChange={(e) => setSemesterStart(e.target.value)} className="input" />
          {windows && (
            <p className="mt-2 text-xs text-faint">
              Tests ≈ {windows.tests} · Exams ≈ {windows.exams}
            </p>
          )}
        </Field>

        <Field label="Course materials">
          <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-line bg-surface px-5 py-8 text-center transition hover:border-gold-dim">
            <input
              type="file"
              multiple
              accept=".zip,.pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,application/zip,application/pdf,image/*,text/plain,text/csv"
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <span className="text-sm text-muted">
              {files.length > 0 ? (
                <span className="text-paper">{files.length === 1 ? files[0].name : `${files.length} files selected`}</span>
              ) : (
                <>Tap to choose files — PDFs, images, notes, or a .zip (mix is fine)</>
              )}
            </span>
          </label>
          {files.length > 1 && (
            <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto font-mono text-[11px] text-faint">
              {files.map((f, i) => <li key={i} className="truncate">· {f.name}</li>)}
            </ul>
          )}
        </Field>

        {error && <p className="text-sm text-rust">{error}</p>}

        <button
          onClick={submit}
          disabled={busy}
          className="w-full rounded-full bg-gold py-3 text-sm font-medium text-ink transition hover:bg-gold-dim disabled:opacity-50"
        >
          {busy ? status || "Working…" : "Start onboarding"}
        </button>
      </div>

      <style jsx global>{`
        .input {
          width: 100%;
          border-radius: 0.75rem;
          border: 1px solid var(--color-line);
          background: var(--color-surface);
          padding: 0.75rem 1rem;
          color: var(--color-paper);
          font-size: 0.95rem;
          outline: none;
        }
        .input:focus {
          border-color: var(--color-gold-dim);
        }
        .input::placeholder {
          color: var(--color-faint);
        }
      `}</style>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-muted">{label}</label>
      {children}
    </div>
  );
}
