import { NextResponse } from "next/server";

import { adminAuthFromRequest } from "@/lib/auth";
import { promoteToPublished } from "@/lib/bundle-store";
import { sql, type SubmissionRow } from "@/lib/db";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await adminAuthFromRequest(request);
  if (!ctx) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const { id } = await context.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id." }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { note?: string } | null;
  const note = typeof body?.note === "string" ? body.note.slice(0, 1000) : null;

  const subs = await sql<SubmissionRow[]>`
    select * from community.submissions where id = ${id}
  `;
  const submission = subs[0];
  if (!submission) return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  if (submission.status !== "pending") {
    return NextResponse.json({ error: `Submission is already ${submission.status}.` }, { status: 409 });
  }

  // Determine next version number for this slug from this publisher.
  const versions = await sql<Array<{ next: number }>>`
    select coalesce(max(bundle_format), 0) + 1 as next
    from community.submissions
    where upstream_slug = ${submission.upstream_slug}
      and status in ('approved', 'superseded')
  `;
  const version = versions[0]?.next ?? 1;

  const publishedPath = await promoteToPublished(submission.bundle_path, submission.upstream_slug, version, submission.bundle_sha256);

  await sql.begin(async (trx) => {
    await trx`
      update community.submissions
      set status = 'approved',
          reviewed_by = ${ctx.publisher.github_login},
          reviewed_at = now(),
          review_notes = ${note},
          bundle_path = ${publishedPath}
      where id = ${id}
    `;
    // Mark any previous approved submission of this slug from this publisher as superseded.
    await trx`
      update community.submissions
      set status = 'superseded'
      where upstream_slug = ${submission.upstream_slug}
        and publisher_id = ${submission.publisher_id}
        and status = 'approved'
        and id <> ${id}
    `;
    await trx`
      insert into community.designs (slug, current_submission, first_published_at, last_updated_at)
      values (${submission.upstream_slug}, ${id}, now(), now())
      on conflict (slug) do update
        set current_submission = excluded.current_submission,
            last_updated_at = now()
    `;
    await trx`
      insert into community.audit_log (submission_id, actor_login, action, note)
      values (${id}, ${ctx.publisher.github_login}, 'approve', ${note})
    `;
  });

  return NextResponse.json(
    { ok: true, slug: submission.upstream_slug, version },
    { headers: { "cache-control": "no-store" } },
  );
}
