import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { adminAuthFromRequest } from "@/lib/auth";
import { sql, type SubmissionRow } from "@/lib/db";
import { mimeFor } from "@/lib/mime";
import { ensureBundleExtracted, resolveBundleFile } from "@/lib/preview-extract";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ id: string; path: string[] }> }) {
  const ctx = await adminAuthFromRequest(request);
  if (!ctx) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const { id, path: pathParts } = await context.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  const requested = (pathParts ?? []).join("/");
  if (!requested) return NextResponse.json({ error: "Missing path." }, { status: 400 });

  const rows = await sql<SubmissionRow[]>`select * from community.submissions where id = ${id}`;
  const submission = rows[0];
  if (!submission) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const root = await ensureBundleExtracted(submission.bundle_path, submission.bundle_sha256);
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
      "cache-control": "private, max-age=600",
    },
  });
}
