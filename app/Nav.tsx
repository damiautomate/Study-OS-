"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ensureSession } from "@/lib/supabase/client";

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

  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-ink/80 backdrop-blur-md">
      <div className="mx-auto flex h-12 max-w-3xl items-center justify-between px-5">
        <Link href="/" className="group flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-[5px] bg-gold text-ink">
            <span className="font-display text-[13px] italic leading-none">S</span>
          </span>
          <span className="font-display text-[15px] tracking-tight text-paper transition group-hover:text-gold">Study OS</span>
        </Link>
        <div className="label !tracking-[0.16em]">
          {!ready ? null : email ? (
            <span className="normal-case text-faint">{email} · <button onClick={signOut} className="transition hover:text-muted">sign out</button></span>
          ) : (
            <Link href="/login" className="normal-case text-gold-dim transition hover:text-gold">sign in</Link>
          )}
        </div>
      </div>
    </header>
  );
}
