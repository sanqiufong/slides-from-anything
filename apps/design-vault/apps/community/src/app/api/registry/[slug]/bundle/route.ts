import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { absoluteBundlePath, bundleExists } from "@/lib/bundle-store";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { getRegistryRow, incrementDownloads } from "@/lib/registry";

export const runtime = "nodejs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "Invalid slug." }, { status: 400 });

  const limit = rateLimit(clientKey(request, "bundle-download"), 10, 60);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many downloads." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const row = await getRegistryRow(slug);
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!(await bundleExists(row.submission.bundle_path))) {
    return NextResponse.json({ error: "Bundle file missing on server." }, { status: 410 });
  }

  const etag = `"${row.submission.bundle_sha256}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { etag } });
  }

  await incrementDownloads(slug);

  const filePath = absoluteBundlePath(row.submission.bundle_path);
  const nodeStream = createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new NextResponse(webStream, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(row.submission.bundle_bytes),
      "content-disposition": `attachment; filename="${slug}.tgz"`,
      etag,
      "cache-control": "public, max-age=3600",
    },
  });
}
