import { NextResponse } from "next/server";

import { clearCommunityToken } from "@/lib/auth-storage";
import { logoutCommunity } from "@/lib/community-client";

export const runtime = "nodejs";

export async function POST() {
  await logoutCommunity();
  const next = await clearCommunityToken();
  return NextResponse.json({ ok: true, baseUrl: next?.baseUrl ?? "" }, { headers: { "cache-control": "no-store" } });
}
