import { NextResponse } from "next/server";

import { adminAuthFromRequest } from "@/lib/auth";
import { removeBundleFile } from "@/lib/bundle-store";
import { sql, type SubmissionRow } from "@/lib/db";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await adminAuthFromRequest(request);
  if (!ctx) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const { id } = await context.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id." }, { status: 400 });

  const body = (await request.json().catch(() => null)) as { note?: string } | null;
  const note = typeof body?.note === "string" ? body.note.slice(0, 1000) : "";
  if (!note.trim()) return NextResponse.json({ error: "Rejection requires a note." }, { status: 400 });

  const subs = await sql<SubmissionRow[]>`
    select * from community.submissions where id = ${id}
  `;
  const submission = subs[0];
  if (!submission) return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  if (submission.status !== "pending") {
    return NextResponse.json({ error: `Submission is already ${submission.status}.` }, { status: 409 });
  }

  await sql.begin(async (trx) => {
    await trx`
      update community.submissions
      set status = 'rejected',
          reviewed_by = ${ctx.publisher.github_login},
          reviewed_at = now(),
          review_notes = ${note}
      where id = ${id}
    `;
    await trx`
      insert into community.audit_log (submission_id, actor_login, action, note)
      values (${id}, ${ctx.publisher.github_login}, 'reject', ${note})
    `;
  });

  await removeBundleFile(submission.bundle_path);

  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
