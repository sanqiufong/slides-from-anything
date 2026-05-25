import { NextResponse } from "next/server";

import { deleteDesign, getDesign, isSafeDesignSlug, updateDesignTags } from "@/lib/storage";

export async function GET(_: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!isSafeDesignSlug(slug)) {
    return NextResponse.json({ error: "Invalid design slug." }, { status: 400 });
  }

  const design = await getDesign(slug);
  if (!design) return NextResponse.json({ error: "Design not found." }, { status: 404 });
  return NextResponse.json(design, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!isSafeDesignSlug(slug)) {
    return NextResponse.json({ error: "Invalid design slug." }, { status: 400 });
  }

  const deleted = await deleteDesign(slug);
  if (!deleted) return NextResponse.json({ error: "Design not found." }, { status: 404 });
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!isSafeDesignSlug(slug)) {
    return NextResponse.json({ error: "Invalid design slug." }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { tags?: unknown } | null;
  if (!body || !Array.isArray(body.tags)) {
    return NextResponse.json({ error: "Expected a tags array." }, { status: 400 });
  }

  const design = await updateDesignTags(slug, body.tags);
  if (!design) return NextResponse.json({ error: "Design not found." }, { status: 404 });
  return NextResponse.json(design, { headers: { "cache-control": "no-store" } });
}
