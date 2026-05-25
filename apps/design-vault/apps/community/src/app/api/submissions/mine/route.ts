import { NextResponse } from "next/server";

import { authFromRequest } from "@/lib/auth";
import { sql, type SubmissionRow } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const ctx = await authFromRequest(request);
  if (!ctx) return NextResponse.json({ error: "需要登录。" }, { status: 401 });
  const rows = await sql<SubmissionRow[]>`
    select * from community.submissions
    where publisher_id = ${ctx.publisher.id}
    order by submitted_at desc
    limit 100
  `;
  return NextResponse.json(
    rows.map((row) => ({
      id: row.id,
      slug: row.upstream_slug,
      title: row.title,
      status: row.status,
      qualityScore: row.quality_score,
      submittedAt: row.submitted_at,
      reviewedAt: row.reviewed_at,
      reviewNotes: row.review_notes,
    })),
    { headers: { "cache-control": "no-store" } },
  );
}
