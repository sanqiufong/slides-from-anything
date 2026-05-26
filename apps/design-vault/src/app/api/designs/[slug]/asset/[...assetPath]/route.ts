import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { designDir, isSafeDesignSlug, pathExists } from "@/lib/storage";

const MIME_BY_EXT: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

async function resolveAssetPath(slug: string, assetPath: string[]) {
  const candidates = [slug, slug.startsWith("community-") ? null : `community-${slug}`].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (!isSafeDesignSlug(candidate)) continue;
    const filePath = path.join(designDir(candidate), "assets", ...assetPath);
    if (await pathExists(filePath)) return filePath;
  }
  return null;
}

export async function GET(_: Request, context: { params: Promise<{ slug: string; assetPath: string[] }> }) {
  const { slug, assetPath } = await context.params;
  if (
    !isSafeDesignSlug(slug) ||
    assetPath.some((segment) => segment === ".." || segment.includes("/") || segment.includes("\\"))
  ) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }
  const filePath = await resolveAssetPath(slug, assetPath);
  if (!filePath) return NextResponse.json({ error: "Asset not found." }, { status: 404 });

  const buffer = await readFile(filePath);
  return new NextResponse(buffer, { headers: { "content-type": MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream", "cache-control": "public, max-age=3600" } });
}
