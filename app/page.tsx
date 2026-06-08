"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ensureSession } from "@/lib/supabase/client";
import type { Course } from "@/lib/types";

export default function Home() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [needsIntake, setNeedsIntake] = useState(false);
  const [account, setAccount] = useState<{ email: string | null; guest: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = await ensureSession();
      const { data: { user } } = await supabase.auth.getUser();
      setAccount({ email: user?.email ?? null, guest: !!user?.is_anonymous });
      const { data: profile } = await supabase.from("student_profile").select("user_id").maybeSingle();
      setNeedsIntake(!profile);
      const { data } = await supabase
        .from("courses")
        .select("*")
        .order("created_at", { ascending: false });
      setCourses((data as Course[]) ?? []);
    })();
  }, []);

  async function signOut() {
    const { createClient } = await import("@/lib/supabase/client");
    await createClient().auth.signOut();
    window.location.reload();
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-12 sm:py-20">
      <div className="mb-8 flex justify-end text-xs">
        {account?.email ? (
          <span className="text-faint">{account.email} · <button onClick={signOut} className="hover:text-muted">sign out</button></span>
        ) : (
          <Link href="/login" className="text-gold-dim hover:text-gold">Sign in / create account</Link>
        )}
      </div>
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

      {needsIntake && (
        <Link href="/welcome" className="mt-6 block rounded-xl border border-gold/30 bg-gold/5 px-5 py-4 transition hover:border-gold/60">
          <p className="text-sm text-paper">Tell the agent about you →</p>
          <p className="mt-0.5 text-xs text-muted">A one-minute intake so guidance is built around your goals, not generic.</p>
        </Link>
      )}

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
