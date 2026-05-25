import { NextResponse } from "next/server";

import { saveModelRuntimeConfig, scanModelRuntime, type SaveModelConfigInput } from "@/lib/model-config";

export const runtime = "nodejs";

export async function GET() {
  const scan = await scanModelRuntime();
  return NextResponse.json(scan);
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as SaveModelConfigInput | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  try {
    const config = await saveModelRuntimeConfig(body);
    return NextResponse.json({ config });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
