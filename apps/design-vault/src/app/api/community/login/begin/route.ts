import { NextResponse } from "next/server";

import { normalizeBaseUrl, readCommunityAuth } from "@/lib/auth-storage";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await readCommunityAuth();
  if (!auth?.baseUrl) {
    return NextResponse.json({ error: "请先设置社区 server URL（/community 页面或下面的设置）。" }, { status: 400 });
  }
  // Build a return URL on THIS local dev server. The local OAuth proxy on the
  // community server will redirect back here with ?token=... after the user
  // authorizes on GitHub.
  const here = new URL(request.url);
  const localBase = `${here.protocol}//${here.host}`;
  const returnUrl = `${localBase}/api/community/oauth/return`;
  const authUrl = `${normalizeBaseUrl(auth.baseUrl)}/api/auth/cli?return=${encodeURIComponent(returnUrl)}`;
  return NextResponse.json({ authUrl }, { headers: { "cache-control": "no-store" } });
}
