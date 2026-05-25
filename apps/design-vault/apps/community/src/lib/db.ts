import postgres from "postgres";

import { env } from "./env";

declare global {
  var __dvCommunitySql: ReturnType<typeof postgres> | undefined;
}

export const sql =
  globalThis.__dvCommunitySql ??
  postgres(env.databaseUrl, {
    max: 8,
    idle_timeout: 30,
    connect_timeout: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__dvCommunitySql = sql;
}

export type PublisherRow = {
  id: string;
  github_login: string;
  github_id: number;
  email: string | null;
  display_name: string | null;
  created_at: Date;
  banned_at: Date | null;
  banned_reason: string | null;
};

export type SubmissionRow = {
  id: string;
  publisher_id: string;
  upstream_slug: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  source_host: string | null;
  source_mode: string | null;
  archetype: string | null;
  quality_score: number | null;
  quality_grade: string | null;
  bundle_format: number;
  bundle_bytes: number;
  bundle_sha256: string;
  bundle_path: string;
  manifest: unknown;
  tags: string[];
  license: string;
  status: "pending" | "approved" | "rejected" | "superseded" | "retracted";
  review_notes: string | null;
  reviewed_by: string | null;
  submitted_at: Date;
  reviewed_at: Date | null;
};

export type DesignRow = {
  slug: string;
  current_submission: string;
  total_downloads: number;
  first_published_at: Date;
  last_updated_at: Date;
};
