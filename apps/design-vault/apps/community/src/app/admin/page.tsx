import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AdminQueue } from "@/components/AdminQueue";
import { ADMIN_COOKIE } from "@/lib/auth";
import { sql } from "@/lib/db";
import { env, isAdmin } from "@/lib/env";
import { resolveSession } from "@/lib/sessions";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  upstream_slug: string;
  title: string;
  summary: string | null;
  status: string;
  quality_score: number | null;
  quality_grade: string | null;
  bundle_bytes: number;
  bundle_sha256: string;
  submitted_at: Date;
  reviewed_at: Date | null;
  publisher_login: string;
  publisher_display_name: string | null;
};

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const params = await searchParams;
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value ?? null;
  const publisher = await resolveSession(token);

  if (!publisher) {
    const githubLogin = new URL("https://github.com/login/oauth/authorize");
    githubLogin.searchParams.set("client_id", env.githubClientId);
    githubLogin.searchParams.set("redirect_uri", `${env.publicBaseUrl}/api/auth/github/callback`);
    githubLogin.searchParams.set("scope", "read:user user:email");
    redirect(githubLogin.toString());
  }
  if (!isAdmin({ login: publisher.github_login, id: Number(publisher.github_id) })) {
    return (
      <main>
        <h1>无权访问</h1>
        <p>当前账号 @{publisher.github_login} 不在 ADMIN_GITHUB_LOGINS 名单里。</p>
      </main>
    );
  }

  const statusFilter = params.status && ["pending", "approved", "rejected", "superseded"].includes(params.status)
    ? params.status
    : "pending";

  const rows = await sql<Row[]>`
    select s.id, s.upstream_slug, s.title, s.summary, s.status,
           s.quality_score, s.quality_grade, s.bundle_bytes, s.bundle_sha256,
           s.submitted_at, s.reviewed_at,
           p.github_login as publisher_login,
           p.display_name as publisher_display_name
    from community.submissions s
    join community.publishers p on p.id = s.publisher_id
    where s.status = ${statusFilter}
    order by s.submitted_at asc
    limit 200
  `;

  const queue = rows.map((row) => ({
    id: row.id,
    slug: row.upstream_slug,
    title: row.title,
    summary: row.summary ?? "",
    status: row.status,
    qualityScore: row.quality_score,
    qualityGrade: row.quality_grade,
    bundleBytes: row.bundle_bytes,
    bundleSha256: row.bundle_sha256,
    submittedAt: row.submitted_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    publisher: { login: row.publisher_login, displayName: row.publisher_display_name },
  }));

  return (
    <main>
      <p className="eyebrow">登录身份 @{publisher.github_login} · admin</p>
      <h1>审核队列</h1>
      <div className="row" style={{ marginTop: 12 }}>
        {(["pending", "approved", "rejected", "superseded"] as const).map((status) => (
          <a key={status} className="badge muted" href={`?status=${status}`} style={{ textDecoration: "none" }}>
            {status}
          </a>
        ))}
      </div>
      <AdminQueue initial={queue} status={statusFilter} />
    </main>
  );
}
