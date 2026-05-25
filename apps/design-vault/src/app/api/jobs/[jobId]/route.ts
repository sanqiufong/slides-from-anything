import { NextResponse } from "next/server";

import { getJob } from "@/lib/storage";

export async function GET(_: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const job = await getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json(job, { headers: { "cache-control": "no-store" } });
}
