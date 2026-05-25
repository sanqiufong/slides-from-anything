import { NextResponse } from "next/server";

import { listDesigns } from "@/lib/storage";

export async function GET() {
  const designs = await listDesigns();
  return NextResponse.json(designs, { headers: { "cache-control": "no-store" } });
}
