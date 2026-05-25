import { NextResponse } from "next/server";

import { clientKey, rateLimit } from "@/lib/rate-limit";
import { listRegistry } from "@/lib/registry";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const limit = rateLimit(clientKey(request, "registry-list"), 60, 60);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }
  const url = new URL(request.url);
  const designs = await listRegistry({
    tag: url.searchParams.get("tag") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
  });
  return NextResponse.json(
    { designs, generatedAt: new Date().toISOString() },
    { headers: { "cache-control": "public, max-age=30" } },
  );
}
