import { NextResponse } from "next/server";

import { clientKey, rateLimit } from "@/lib/rate-limit";
import { startDeviceFlow } from "@/lib/github";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limit = rateLimit(clientKey(request, "device-start"), 30, 60 * 60);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试。" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }
  try {
    const start = await startDeviceFlow();
    return NextResponse.json(start, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "GitHub 设备流启动失败。" },
      { status: 502 },
    );
  }
}
