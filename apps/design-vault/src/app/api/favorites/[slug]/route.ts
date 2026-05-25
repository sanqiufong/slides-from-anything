import { NextResponse } from "next/server";

import { isSafeDesignSlug, setFavorite } from "@/lib/storage";

export async function PUT(_: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!isSafeDesignSlug(slug)) {
    return NextResponse.json({ error: "Invalid design slug." }, { status: 400 });
  }
  const next = await setFavorite(slug, true);
  if (!next) return NextResponse.json({ error: "Design not found." }, { status: 404 });
  return NextResponse.json(
    { slug, favorite: true, slugs: [...next].sort() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(_: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!isSafeDesignSlug(slug)) {
    return NextResponse.json({ error: "Invalid design slug." }, { status: 400 });
  }
  const next = await setFavorite(slug, false);
  if (!next) return NextResponse.json({ error: "Design not found." }, { status: 404 });
  return NextResponse.json(
    { slug, favorite: false, slugs: [...next].sort() },
    { headers: { "cache-control": "no-store" } },
  );
}
