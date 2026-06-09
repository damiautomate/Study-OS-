"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ensureSession } from "@/lib/supabase/client";

const TABS = [
  { href: "/", label: "Today", icon: "M12 3v2m0 14v2M5.2 5.2l1.4 1.4m10.8 10.8 1.4 1.4M3 12h2m14 0h2M5.2 18.8l1.4-1.4M17.4 6.6l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
  { href: "/courses", label: "Courses", icon: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM4 17h13.5M8 7h8M8 10.5h5" },
  { href: "/you", label: "You", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0" },
];

export default function Nav() {
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const supabase = await ensureSession();
      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? null);
      setReady(true);
    })();
  }, [pathname]);

  async function signOut() {
    const { createClient } = await import("@/lib/supabase/client");
    await createClient().auth.signOut();
    window.location.href = "/";
  }

  if (pathname === "/login") return null;
  const active = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href) || (href === "/courses" && pathname.startsWith("/courses"));

  return (
    <>
      {/* top bar */}
      <header className="sticky top-0 z-40 border-b border-line/80 bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex h-12 max-w-3xl items-center justify-between px-5">
          <Link href="/" className="group flex items-center gap-2">
            <span className="grid h-5 w-5 place-items-center rounded-[6px] bg-gold text-ink shadow-sm">
              <span className="font-display text-[12px] font-bold leading-none text-ink">S</span>
            </span>
            <span className="font-display text-[15px] font-semibold tracking-tight text-paper">Study OS</span>
          </Link>
          <div className="flex items-center gap-5">
            <nav className="hidden items-center gap-1 sm:flex">
              {TABS.map((t) => (
                <Link key={t.href} href={t.href}
                  className={`rounded-full px-3 py-1.5 text-sm transition ${active(t.href) ? "bg-raised font-medium text-paper" : "text-muted hover:text-paper"}`}>
                  {t.label}
                </Link>
              ))}
            </nav>
            <div className="font-mono text-[11px]">
              {!ready ? null : email ? (
                <button onClick={signOut} className="text-faint transition hover:text-muted">sign out</button>
              ) : (
                <Link href="/login" className="text-gold transition hover:text-gold-dim">sign in</Link>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur-md sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="mx-auto flex max-w-md items-stretch justify-around">
          {TABS.map((t) => {
            const on = active(t.href);
            return (
              <Link key={t.href} href={t.href} className="flex flex-1 flex-col items-center gap-0.5 py-2.5">
                <svg viewBox="0 0 24 24" className={`h-[22px] w-[22px] ${on ? "text-gold" : "text-faint"}`}
                  fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d={t.icon} />
                </svg>
                <span className={`text-[10px] ${on ? "font-semibold text-paper" : "text-faint"}`}>{t.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
