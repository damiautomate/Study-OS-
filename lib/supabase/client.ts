"use client";

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

// Slice 1 uses anonymous auth so RLS works without a login screen.
// Replace with real auth later — every row is already keyed to a user_id.
export async function ensureSession() {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
  }
  return supabase;
}
