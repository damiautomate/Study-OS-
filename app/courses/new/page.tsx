"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ensureSession } from "@/lib/supabase/client";
import { describeWindows } from "@/lib/semester";

export default function NewCourse() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [semesterStart, setSemesterStart] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const windows = semesterStart ? describeWindows(semesterStart) : null;

  async function submit() {
    setError("");
    if (!title.trim() || !semesterStart || !file) {
      setError("Add a title, a start date, and a zip file.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Please upload a .zip of the course materials.");
      return;
    }
    setBusy(true);
    try {
      const supabase = await ensureSession();
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user!.id;

      setStatus("Uploading your materials…");
      const zipPath = `${uid}/${crypto.randomUUID()}.zip`;
      const up = await supabase.storage
        .from("course-uploads")
        .upload(zipPath, file, { contentType: "application/zip", upsert: false });
      if (up.error) throw new Error(up.error.message);

      setStatus("Setting things up…");
      const res = await fetch("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), code: code.trim(), semesterStart, zipPath }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Something went wrong.");

      router.push(`/courses/${json.courseId}`);
    } catch (e) {
      setError((e as Error).message);
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
        Zip up everything for the course and drop it in. Tests are assumed around weeks 5–7,
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

        <Field label="Course materials (.zip)">
          <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-line bg-surface px-5 py-8 text-center transition hover:border-gold-dim">
            <input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <span className="text-sm text-muted">
              {file ? (
                <span className="text-paper">{file.name}</span>
              ) : (
                <>Tap to choose a .zip file</>
              )}
            </span>
          </label>
        </Field>

        {error && <p className="text-sm text-rust">{error}</p>}

        <button
          onClick={submit}
          disabled={busy}
          className="w-full rounded-full bg-gold py-3 text-sm font-medium text-ink transition hover:bg-paper disabled:opacity-50"
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
