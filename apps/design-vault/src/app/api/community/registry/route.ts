import { NextResponse } from "next/server";

import { fetchRegistry } from "@/lib/community-client";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const designs = await fetchRegistry({
      tag: url.searchParams.get("tag") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    });
    return NextResponse.json({ designs }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "registry fetch failed." },
      { status: 502 },
    );
  }
}
