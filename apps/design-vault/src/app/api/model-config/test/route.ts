import { NextResponse } from "next/server";

import { testModelRuntimeConfig, type SaveModelConfigInput } from "@/lib/model-config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Partial<SaveModelConfigInput> | null;

  try {
    const result = await testModelRuntimeConfig(body ?? undefined);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
