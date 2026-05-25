import { NextResponse } from "next/server";

import { readFavorites } from "@/lib/storage";

export async function GET() {
  const favorites = await readFavorites();
  return NextResponse.json(
    { slugs: [...favorites].sort() },
    { headers: { "cache-control": "no-store" } },
  );
}
