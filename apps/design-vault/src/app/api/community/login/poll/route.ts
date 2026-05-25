import { NextResponse } from "next/server";

import { readCommunityAuth, writeCommunityAuth } from "@/lib/auth-storage";
import { pollDeviceLogin } from "@/lib/community-client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await readCommunityAuth();
  if (!auth?.baseUrl) {
    return NextResponse.json({ error: "未设置 baseUrl。" }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as { device_code?: string } | null;
  if (!body || typeof body.device_code !== "string" || !body.device_code) {
    return NextResponse.json({ error: "缺少 device_code。" }, { status: 400 });
  }
  const result = await pollDeviceLogin(auth.baseUrl, body.device_code);
  if (result.status === "ok") {
    await writeCommunityAuth({
      baseUrl: auth.baseUrl,
      token: result.token,
      login: result.login,
      displayName: result.displayName,
      isAdmin: result.isAdmin,
    });
  }
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
