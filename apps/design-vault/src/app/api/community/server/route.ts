import { NextResponse } from "next/server";

import { normalizeBaseUrl, readCommunityAuth, writeCommunityAuth } from "@/lib/auth-storage";

export const runtime = "nodejs";

export async function GET() {
  const auth = await readCommunityAuth();
  return NextResponse.json(
    {
      configured: Boolean(auth?.baseUrl),
      baseUrl: auth?.baseUrl ?? "",
      loggedIn: Boolean(auth?.token),
      login: auth?.login ?? null,
      displayName: auth?.displayName ?? null,
      isAdmin: Boolean(auth?.isAdmin),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as { baseUrl?: string } | null;
  if (!body || typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
    return NextResponse.json({ error: "请提供 baseUrl。" }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(body.baseUrl);
  } catch {
    return NextResponse.json({ error: "baseUrl 不是合法 URL。" }, { status: 400 });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return NextResponse.json({ error: "baseUrl 必须是 http(s)。" }, { status: 400 });
  }
  const existing = await readCommunityAuth();
  const next = await writeCommunityAuth({
    baseUrl: normalizeBaseUrl(parsed.toString()),
    token: existing?.token,
    login: existing?.login,
    displayName: existing?.displayName,
    isAdmin: existing?.isAdmin,
  });
  return NextResponse.json({ baseUrl: next.baseUrl }, { headers: { "cache-control": "no-store" } });
}
