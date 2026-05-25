import { NextResponse } from "next/server";

import { fetchMySubmissions } from "@/lib/community-client";

export const runtime = "nodejs";

export async function GET() {
  try {
    const submissions = await fetchMySubmissions();
    return NextResponse.json({ submissions }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "fetch failed", submissions: [] },
      { status: 502 },
    );
  }
}
