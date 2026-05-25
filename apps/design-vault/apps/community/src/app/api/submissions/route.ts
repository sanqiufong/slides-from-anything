import { NextResponse } from "next/server";

import { authFromRequest } from "@/lib/auth";
import { storeIncoming, removeBundleFile } from "@/lib/bundle-store";
import { sql } from "@/lib/db";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { BundleValidationError, extractAndValidate } from "@/lib/validate-bundle";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BUNDLE_BYTES = 80 * 1024 * 1024;

export async function POST(request: Request) {
  const ctx = await authFromRequest(request);
  if (!ctx) return NextResponse.json({ error: "需要登录。" }, { status: 401 });
  if (ctx.publisher.banned_at) return NextResponse.json({ error: "账号已被封禁。" }, { status: 403 });

  const dailyCap = Number(process.env.SUBMISSION_DAILY_CAP) || 50;
  const limit = rateLimit(`publisher:${ctx.publisher.id}`, dailyCap, 24 * 60 * 60);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `今日提交已达 ${dailyCap} 次上限，请明天再来。` },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }
  // additional IP-level cap, intentionally generous.
  const ipLimit = rateLimit(clientKey(request, "submissions-ip"), 200, 24 * 60 * 60);
  if (!ipLimit.ok) {
    return NextResponse.json({ error: "提交过于频繁。" }, { status: 429 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "请用 multipart/form-data 提交。" }, { status: 400 });
  }
  const entry = formData.get("bundle");
  if (!(entry instanceof File)) {
    return NextResponse.json({ error: "缺少 bundle 文件。" }, { status: 400 });
  }
  if (entry.size <= 0) return NextResponse.json({ error: "上传内容为空。" }, { status: 400 });
  if (entry.size > MAX_BUNDLE_BYTES) {
    return NextResponse.json(
      { error: `Bundle 超过 ${(MAX_BUNDLE_BYTES / 1024 / 1024).toFixed(0)}MB 上限。` },
      { status: 413 },
    );
  }

  const buffer = Buffer.from(await entry.arrayBuffer());

  let manifest;
  try {
    manifest = await extractAndValidate(buffer);
  } catch (error) {
    if (error instanceof BundleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Bundle 校验失败。" }, { status: 400 });
  }

  // Quality floor — reject obviously broken bundles up front.
  if (typeof manifest.qualityScore === "number" && manifest.qualityScore < 60) {
    return NextResponse.json(
      { error: `质量分 ${manifest.qualityScore} 低于上传门槛 60。请先在本地提升后再发布。` },
      { status: 400 },
    );
  }

  const stored = await storeIncoming(buffer);

  // Conflict: another publisher already owns this slug?
  const slugOwner = await sql<Array<{ publisher_id: string }>>`
    select s.publisher_id
    from community.designs d
    join community.submissions s on s.id = d.current_submission
    where d.slug = ${manifest.slug}
    limit 1
  `;
  if (slugOwner[0] && slugOwner[0].publisher_id !== ctx.publisher.id) {
    await removeBundleFile(stored.relativePath);
    return NextResponse.json(
      { error: `slug ${manifest.slug} 已被其他发布者占用。` },
      { status: 409 },
    );
  }

  try {
    const rows = await sql<Array<{ id: string }>>`
      insert into community.submissions (
        publisher_id, upstream_slug, title, summary, source_url, source_host, source_mode,
        archetype, quality_score, quality_grade, bundle_format, bundle_bytes, bundle_sha256, bundle_path,
        manifest, tags, license, status
      ) values (
        ${ctx.publisher.id}, ${manifest.slug}, ${manifest.title}, ${manifest.summary},
        ${manifest.sourceUrl}, ${manifest.sourceHost}, ${manifest.sourceMode},
        ${manifest.archetype ?? null}, ${manifest.qualityScore ?? null}, ${manifest.qualityGrade ?? null},
        ${manifest.bundleFormatVersion}, ${stored.bytes}, ${stored.sha256}, ${stored.relativePath},
        ${sql.json(manifest)}, ${manifest.tags}, ${manifest.license}, 'pending'
      )
      returning id
    `;
    const submissionId = rows[0].id;
    await sql`
      insert into community.audit_log (submission_id, actor_login, action, note)
      values (${submissionId}, ${ctx.publisher.github_login}, 'submit', ${"sha256=" + stored.sha256})
    `;
    return NextResponse.json(
      {
        submissionId,
        status: "pending",
        sha256: stored.sha256,
        bytes: stored.bytes,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await removeBundleFile(stored.relativePath);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存失败。" },
      { status: 500 },
    );
  }
}
