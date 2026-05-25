import { NextResponse } from "next/server";

import { publishToServer } from "@/lib/community";
import { isSafeDesignSlug } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { slug?: string } | null;
  if (!body?.slug || !isSafeDesignSlug(body.slug)) {
    return NextResponse.json({ error: "Invalid slug." }, { status: 400 });
  }
  try {
    const result = await publishToServer(body.slug);
    return NextResponse.json(
      {
        ok: true,
        slug: result.bundle.slug,
        title: result.bundle.title,
        submissionId: result.submissionId,
        status: result.status,
        bytes: result.bundle.bytes,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "publish failed" },
      { status: 502 },
    );
  }
}
