import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { designDir, isSafeDesignSlug, pathExists } from "@/lib/storage";

/**
 * Bundle file route. Mirrors the layout of a packaged design's tarball so the
 * same relative URLs work everywhere: locally during preview rendering, on the
 * community server when iframing approved bundles, and when an installer re-
 * extracts a bundle from someone else. Strict path containment — any `..`
 * segment refuses to serve.
 */

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export async function GET(_: Request, context: { params: Promise<{ slug: string; path: string[] }> }) {
  const { slug, path: pathParts } = await context.params;
  if (!isSafeDesignSlug(slug)) return NextResponse.json({ error: "Invalid slug." }, { status: 400 });
  if (!pathParts || pathParts.length === 0) return NextResponse.json({ error: "Missing path." }, { status: 400 });
  if (pathParts.some((segment) => segment === "..")) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }
  const root = designDir(slug);
  const full = path.join(root, ...pathParts);
  // Defense-in-depth: even after path.join, ensure the resolved path is still
  // within the design directory.
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!path.resolve(full).startsWith(normalizedRoot)) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }
  if (!(await pathExists(full))) {
    return NextResponse.json({ error: "File not in bundle." }, { status: 404 });
  }
  try {
    const s = await stat(full);
    if (!s.isFile()) return NextResponse.json({ error: "Not a file." }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "File not in bundle." }, { status: 404 });
  }
  const buffer = await readFile(full);
  return new NextResponse(buffer, {
    headers: {
      "content-type": MIME_BY_EXT[path.extname(full).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "public, max-age=3600",
    },
  });
}
