import { NextResponse } from "next/server";

import { bundleDesign } from "@/lib/community";
import { isSafeDesignSlug } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!isSafeDesignSlug(slug)) {
    return NextResponse.json({ error: "Invalid design slug." }, { status: 400 });
  }
  try {
    const result = await bundleDesign(slug);
    return NextResponse.json(
      {
        slug: result.slug,
        title: result.title,
        bundlePath: result.bundlePath,
        bytes: result.bytes,
        version: result.version,
        submission: result.submission,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "导出社区包失败。" },
      { status: 400 },
    );
  }
}
