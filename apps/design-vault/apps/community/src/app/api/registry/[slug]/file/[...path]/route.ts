import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { mimeFor } from "@/lib/mime";
import { ensureBundleExtracted, resolveBundleFile } from "@/lib/preview-extract";
import { getRegistryRow } from "@/lib/registry";

export const runtime = "nodejs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function GET(_: Request, context: { params: Promise<{ slug: string; path: string[] }> }) {
  const { slug, path: pathParts } = await context.params;
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "Invalid slug." }, { status: 400 });
  const requested = (pathParts ?? []).join("/");
  if (!requested) return NextResponse.json({ error: "Missing path." }, { status: 400 });

  const row = await getRegistryRow(slug);
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const root = await ensureBundleExtracted(row.submission.bundle_path, row.submission.bundle_sha256);
  if (!root) return NextResponse.json({ error: "Bundle missing on server." }, { status: 410 });

  const full = resolveBundleFile(root, requested);
  if (!full) return NextResponse.json({ error: "Invalid path." }, { status: 400 });

  let size: number;
  try {
    const s = await stat(full);
    if (!s.isFile()) return NextResponse.json({ error: "Not a file." }, { status: 404 });
    size = s.size;
  } catch {
    return NextResponse.json({ error: "File not in bundle." }, { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>;
  return new NextResponse(stream, {
    headers: {
      "content-type": mimeFor(full),
      "content-length": String(size),
      "cache-control": "public, max-age=3600",
    },
  });
}
