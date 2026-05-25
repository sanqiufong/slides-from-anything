import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { ADMIN_COOKIE } from "@/lib/auth";
import { extractBearer, revokeSession } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const bearer = extractBearer(request);
  if (bearer) await revokeSession(bearer);
  const jar = await cookies();
  const cookieToken = jar.get(ADMIN_COOKIE)?.value;
  if (cookieToken) await revokeSession(cookieToken);
  jar.delete(ADMIN_COOKIE);
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
