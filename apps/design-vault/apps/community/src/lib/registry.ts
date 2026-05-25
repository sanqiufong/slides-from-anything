import { env } from "./env";
import { sql, type DesignRow, type PublisherRow, type SubmissionRow } from "./db";

export type RegistryEntry = {
  slug: string;
  title: string;
  summary: string;
  archetype?: string;
  qualityScore?: number;
  qualityGrade?: string;
  tags: string[];
  publisher: { login: string; displayName?: string };
  bundleBytes: number;
  bundleSha256: string;
  bundleFormat: number;
  bundleUrl: string;
  updatedAt: string;
  publishedAt: string;
  downloads: number;
  manifest: {
    sourceHost: string;
    sourceMode: string;
    license: string;
  };
};

type Joined = SubmissionRow & {
  d_slug: string;
  d_total_downloads: number;
  d_first_published_at: Date;
  d_last_updated_at: Date;
  p_github_login: string;
  p_display_name: string | null;
};

export async function listRegistry(filters: { tag?: string; q?: string; since?: string }): Promise<RegistryEntry[]> {
  const since = filters.since ? new Date(filters.since) : null;
  const q = filters.q?.toLowerCase().trim() ?? "";
  const tag = filters.tag?.trim() ?? "";

  const rows = await sql<Joined[]>`
    select
      s.*,
      d.slug as d_slug,
      d.total_downloads as d_total_downloads,
      d.first_published_at as d_first_published_at,
      d.last_updated_at as d_last_updated_at,
      p.github_login as p_github_login,
      p.display_name as p_display_name
    from community.designs d
    join community.submissions s on s.id = d.current_submission
    join community.publishers p on p.id = s.publisher_id
    where (${tag} = '' or ${tag} = any(s.tags))
      and (${q} = '' or lower(s.title) like ${"%" + q + "%"} or lower(coalesce(s.summary, '')) like ${"%" + q + "%"})
      and (${since}::timestamptz is null or d.last_updated_at >= ${since})
    order by d.last_updated_at desc
    limit 200
  `;

  return rows.map(toEntry);
}

export async function getRegistryEntry(slug: string): Promise<RegistryEntry | null> {
  const rows = await sql<Joined[]>`
    select
      s.*,
      d.slug as d_slug,
      d.total_downloads as d_total_downloads,
      d.first_published_at as d_first_published_at,
      d.last_updated_at as d_last_updated_at,
      p.github_login as p_github_login,
      p.display_name as p_display_name
    from community.designs d
    join community.submissions s on s.id = d.current_submission
    join community.publishers p on p.id = s.publisher_id
    where d.slug = ${slug}
    limit 1
  `;
  return rows[0] ? toEntry(rows[0]) : null;
}

export async function getRegistryRow(slug: string): Promise<{ design: DesignRow; submission: SubmissionRow; publisher: PublisherRow } | null> {
  const rows = await sql<Joined[]>`
    select
      s.*,
      d.slug as d_slug,
      d.total_downloads as d_total_downloads,
      d.first_published_at as d_first_published_at,
      d.last_updated_at as d_last_updated_at,
      p.github_login as p_github_login,
      p.display_name as p_display_name
    from community.designs d
    join community.submissions s on s.id = d.current_submission
    join community.publishers p on p.id = s.publisher_id
    where d.slug = ${slug}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const { d_slug, d_total_downloads, d_first_published_at, d_last_updated_at, p_github_login, p_display_name, ...submission } = row;
  void p_github_login;
  void p_display_name;
  const design: DesignRow = {
    slug: d_slug,
    current_submission: submission.id,
    total_downloads: d_total_downloads,
    first_published_at: d_first_published_at,
    last_updated_at: d_last_updated_at,
  };
  // hydrate publisher
  const publishers = await sql<PublisherRow[]>`
    select * from community.publishers where id = ${submission.publisher_id}
  `;
  return { design, submission: submission as SubmissionRow, publisher: publishers[0] };
}

export async function incrementDownloads(slug: string): Promise<void> {
  await sql`update community.designs set total_downloads = total_downloads + 1 where slug = ${slug}`;
}

function toEntry(row: Joined): RegistryEntry {
  return {
    slug: row.d_slug,
    title: row.title,
    summary: row.summary ?? "",
    archetype: row.archetype ?? undefined,
    qualityScore: row.quality_score ?? undefined,
    qualityGrade: row.quality_grade ?? undefined,
    tags: row.tags,
    publisher: { login: row.p_github_login, displayName: row.p_display_name ?? undefined },
    bundleBytes: row.bundle_bytes,
    bundleSha256: row.bundle_sha256,
    bundleFormat: row.bundle_format,
    bundleUrl: `${env.publicBaseUrl}/api/registry/${encodeURIComponent(row.d_slug)}/bundle`,
    updatedAt: row.d_last_updated_at.toISOString(),
    publishedAt: row.d_first_published_at.toISOString(),
    downloads: row.d_total_downloads,
    manifest: {
      sourceHost: row.source_host ?? "",
      sourceMode: row.source_mode ?? "url",
      license: row.license,
    },
  };
}
