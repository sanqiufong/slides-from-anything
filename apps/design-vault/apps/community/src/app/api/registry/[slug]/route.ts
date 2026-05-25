import { NextResponse } from "next/server";

import { getRegistryEntry } from "@/lib/registry";

export const runtime = "nodejs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function GET(_: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "Invalid slug." }, { status: 400 });
  const entry = await getRegistryEntry(slug);
  if (!entry) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(entry, { headers: { "cache-control": "public, max-age=60" } });
}
