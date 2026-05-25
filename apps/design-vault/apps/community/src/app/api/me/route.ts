import { NextResponse } from "next/server";

import { authFromRequest } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const ctx = await authFromRequest(request);
  if (!ctx) return NextResponse.json({ authenticated: false }, { headers: { "cache-control": "no-store" } });
  return NextResponse.json(
    {
      authenticated: true,
      login: ctx.publisher.github_login,
      displayName: ctx.publisher.display_name,
      isAdmin: ctx.isAdmin,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
