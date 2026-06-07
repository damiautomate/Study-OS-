"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ensureSession } from "@/lib/supabase/client";
import type { Course } from "@/lib/types";

export default function Home() {
  const [courses, setCourses] = useState<Course[] | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = await ensureSession();
      const { data } = await supabase
        .from("courses")
        .select("*")
        .order("created_at", { ascending: false });
      setCourses((data as Course[]) ?? []);
    })();
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-5 py-12 sm:py-20">
      <header className="mb-12">
        <p className="text-xs uppercase tracking-[0.3em] text-gold-dim mb-3">Study OS</p>
        <h1 className="text-4xl sm:text-5xl leading-[1.05] text-paper">
          Your courses,<br />
          <span className="text-gold italic">in one place.</span>
        </h1>
        <p className="mt-4 text-muted max-w-md leading-relaxed">
          Upload everything for a course — slides, notes, past papers — and it gets
          unpacked, sorted, and read into one clean inventory.
        </p>
      </header>

      <Link
        href="/courses/new"
        className="inline-flex items-center gap-2 rounded-full bg-gold px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-paper"
      >
        + New course
      </Link>

      <section className="mt-12">
        {courses === null ? (
          <p className="text-faint text-sm">Loading…</p>
        ) : courses.length === 0 ? (
          <p className="text-faint text-sm">No courses yet. Add your first one above.</p>
        ) : (
          <ul className="space-y-3">
            {courses.map((c) => (
              <li key={c.id} className="rise">
                <Link
                  href={`/courses/${c.id}`}
                  className="block rounded-xl border border-line bg-surface px-5 py-4 transition hover:border-gold-dim"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h2 className="text-lg text-paper">{c.title}</h2>
                      {c.code && <p className="text-xs text-faint mt-0.5">{c.code}</p>}
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] uppercase tracking-wider ${
                        c.status === "onboarded"
                          ? "bg-sage/15 text-sage"
                          : "bg-gold/15 text-gold"
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
