import { NextResponse } from "next/server";

import { readCommunityAuth } from "@/lib/auth-storage";
import { startDeviceLogin } from "@/lib/community-client";

export const runtime = "nodejs";

export async function POST() {
  const auth = await readCommunityAuth();
  if (!auth?.baseUrl) {
    return NextResponse.json({ error: "请先在『社区服务地址』里保存 base URL。" }, { status: 400 });
  }
  try {
    const start = await startDeviceLogin(auth.baseUrl);
    return NextResponse.json(start, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "device flow start 失败。" },
      { status: 502 },
    );
  }
}
