import { NextResponse } from "next/server";

import { installFromRegistry } from "@/lib/community";
import { isSafeDesignSlug } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { slug?: string } | null;
  if (!body?.slug || !isSafeDesignSlug(body.slug)) {
    return NextResponse.json({ error: "Invalid slug." }, { status: 400 });
  }
  try {
    const result = await installFromRegistry(body.slug);
    return NextResponse.json(
      {
        ok: true,
        slug: result.slug,
        upstreamSlug: result.upstreamSlug,
        title: result.title,
        designDir: result.designDir,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "install failed" },
      { status: 502 },
    );
  }
}
