import { NextResponse } from "next/server";

import { adminAuthFromRequest } from "@/lib/auth";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

type Row = {
  id: string;
  upstream_slug: string;
  title: string;
  summary: string | null;
  status: string;
  quality_score: number | null;
  quality_grade: string | null;
  bundle_bytes: number;
  submitted_at: Date;
  reviewed_at: Date | null;
  publisher_login: string;
  publisher_display_name: string | null;
};

export async function GET(request: Request) {
  const ctx = await adminAuthFromRequest(request);
  if (!ctx) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";
  const rows = await sql<Row[]>`
    select s.id, s.upstream_slug, s.title, s.summary, s.status,
           s.quality_score, s.quality_grade, s.bundle_bytes,
           s.submitted_at, s.reviewed_at,
           p.github_login as publisher_login,
           p.display_name as publisher_display_name
    from community.submissions s
    join community.publishers p on p.id = s.publisher_id
    where s.status = ${status}
    order by s.submitted_at asc
    limit 200
  `;
  return NextResponse.json(
    rows.map((row) => ({
      id: row.id,
      slug: row.upstream_slug,
      title: row.title,
      summary: row.summary,
      status: row.status,
      qualityScore: row.quality_score,
      qualityGrade: row.quality_grade,
      bundleBytes: row.bundle_bytes,
      submittedAt: row.submitted_at,
      reviewedAt: row.reviewed_at,
      publisher: { login: row.publisher_login, displayName: row.publisher_display_name },
    })),
    { headers: { "cache-control": "no-store" } },
  );
}
