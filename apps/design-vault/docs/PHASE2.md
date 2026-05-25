# Phase 2 — Self-Hosted Community Service

Phase 1 delivered the local round-trip: a design can be packed into a `.tgz` bundle and installed back into any machine's `data/designs/community-<slug>/` with paths rewritten correctly. Phase 2 introduces a small **community-server** that holds the canonical registry, an upload queue, and a one-person admin review surface — so users no longer need to swap bundles by hand.

This document is the contract every Phase 2 PR must obey. If reality forces a change, change this file first.

## 1. Boundaries

| Concern | Location |
|---|---|
| Design abstraction (LLM) | Existing local Next.js app. Unchanged. |
| Bundle packaging / installation | Existing `src/lib/community.ts`. Stable. |
| **Registry hosting + auth + review queue** | New `apps/community/` Next.js app, runs on the VPS. |
| Bundle storage | VPS local fs at `/opt/design-vault/bundles/`. DB stores metadata + relative path. |
| Auth | GitHub OAuth device flow. Admin via `ADMIN_GITHUB_LOGINS` env allowlist. |
| TLS + reverse proxy | Caddy via `deploy/Caddyfile`, automatic Let's Encrypt. |
| Database | Postgres in docker-compose, mounted volume. |

Local app and community-server stay **decoupled**: the local app talks to the server via HTTPS only. The server never SSHes into a client and never reaches into the local app. If the server is down, every locally-installed bundle keeps working.

## 2. Data model (Postgres)

Single schema `community`, four tables.

```sql
create table community.publishers (
  id              uuid primary key default gen_random_uuid(),
  github_login    text not null unique,
  github_id       bigint not null unique,
  email           text,
  display_name    text,
  created_at      timestamptz not null default now(),
  banned_at       timestamptz,
  banned_reason   text
);

create table community.submissions (
  id                  uuid primary key default gen_random_uuid(),
  publisher_id        uuid not null references community.publishers(id) on delete cascade,
  upstream_slug       text not null,                    -- slug as it appeared in submission.json
  title               text not null,
  summary             text,
  source_url          text,
  source_host         text,
  source_mode         text,                             -- IngestMode values
  archetype           text,
  quality_score       smallint,
  quality_grade       text,
  bundle_format       smallint not null,                -- submission.json bundleFormatVersion
  bundle_bytes        integer not null,
  bundle_sha256       text not null,
  bundle_path         text not null,                    -- relative to /opt/design-vault/bundles/
  manifest            jsonb not null,                   -- full submission.json
  tags                text[] not null default '{}',
  license             text not null,
  status              text not null
    check (status in ('pending','approved','rejected','superseded','retracted')),
  review_notes        text,
  reviewed_by         text,                             -- github_login of admin
  submitted_at        timestamptz not null default now(),
  reviewed_at         timestamptz
);

create index submissions_status_idx on community.submissions(status);
create index submissions_publisher_idx on community.submissions(publisher_id);
create index submissions_upstream_slug_idx on community.submissions(upstream_slug);

-- "current approved version" view that clients see in /api/registry.
create table community.designs (
  slug                text primary key,                 -- canonical slug used by clients
  current_submission  uuid not null references community.submissions(id),
  total_downloads     integer not null default 0,
  first_published_at  timestamptz not null,
  last_updated_at     timestamptz not null
);

create table community.audit_log (
  id            bigserial primary key,
  submission_id uuid references community.submissions(id) on delete set null,
  actor_login   text not null,
  action        text not null,                          -- 'submit','approve','reject','retract','update'
  note          text,
  created_at    timestamptz not null default now()
);
```

**Slug policy.** Submissions store `upstream_slug`. When approved, `community.designs.slug` is computed as `upstream_slug` unmodified — the *client* prefixes `community-` only at install time (Phase 1 contract). Two different publishers cannot own the same `slug` simultaneously; if a second publisher submits an existing slug, the server returns `409 Conflict` unless they're updating their own prior submission. Renames require admin intervention.

## 3. Submission state machine

```
        submit                  approve
[draft] ─────▶ pending ──────────▶ approved  ◀──── update from same publisher ──┐
                  │                  │   ▲                                       │
       reject │                  │   │ retract                                │
                  ▼                  ▼   │                                       │
              rejected         retracted ─┴── superseded by newer submission ────┘
```

- `pending` is the admin queue.
- `approved` triggers `community.designs` upsert: either insert (new slug) or replace `current_submission` (slug already owned by same publisher).
- `retracted` is publisher-initiated; `community.designs` row is removed but the bundle file stays for forensic until 30 days.
- `superseded` is automatic when a newer submission of the same slug from the same publisher is approved; the old row keeps its bundle for rollback.

## 4. REST contract

All JSON bodies. Errors: `{ "error": "human readable" }`. All endpoints versioned via `Accept: application/vnd.design-vault.v1+json` (default for now, enforced when v2 lands).

### Public

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/registry` | List approved designs. Query: `?tag=`, `?q=`, `?since=ISO`. Returns `{ designs: PublicDesignEntry[], generatedAt }`. |
| `GET` | `/api/registry/<slug>` | Single design metadata + `bundleUrl`. |
| `GET` | `/api/registry/<slug>.tgz` | Streams the bundle, sets `etag` to `bundle_sha256`. Increments `total_downloads`. |
| `GET` | `/api/health` | `{ ok: true }`, no auth. |

`PublicDesignEntry` shape:

```ts
type PublicDesignEntry = {
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
  updatedAt: string;
  publishedAt: string;
  downloads: number;
  // Manifest excerpt for browse UI (no path leaks):
  manifest: {
    sourceHost?: string;
    sourceMode?: string;
    license: string;
  };
};
```

### Authenticated — publisher

Requires `Authorization: Bearer <session-token>` issued by device flow.

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/api/auth/device/start` | — | Initiates GitHub device flow. Returns `{ verification_uri, user_code, device_code, expires_in, interval }`. |
| `POST` | `/api/auth/device/poll` | `{ device_code }` | Returns `{ token, github_login }` when user has authorized. |
| `POST` | `/api/auth/logout` | — | Invalidates current token. |
| `GET` | `/api/me` | — | `{ login, displayName, isAdmin }`. |
| `POST` | `/api/submissions` | multipart `bundle` + `manifest` | Upload. Server re-reads `submission.json` inside the tarball; rejects mismatch. Returns `{ submissionId, status: 'pending' }`. |
| `GET` | `/api/submissions/mine` | — | List my submissions across all statuses. |
| `POST` | `/api/submissions/<id>/retract` | `{ reason? }` | Owner only. |

### Authenticated — admin (allowlisted GitHub logins)

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/api/admin/submissions` | — | Queue: pending first, paginated. |
| `GET` | `/api/admin/submissions/<id>` | — | Full manifest + bundle download link. |
| `POST` | `/api/admin/submissions/<id>/approve` | `{ note? }` | |
| `POST` | `/api/admin/submissions/<id>/reject` | `{ note }` | Note required. |
| `POST` | `/api/admin/publishers/<id>/ban` | `{ reason }` | Cascades: retract all approvals from this publisher. |

### Rate limits

- Submissions: 5 per publisher per 24h.
- Device flow start: 30 per IP per hour.
- Registry list: 60 per IP per minute.
- Bundle download: 10 per IP per minute. Returns `429` with `retry-after`.

## 5. GitHub OAuth device flow (publisher login)

```
local CLI/UI                    community-server                 GitHub
    │                                  │                             │
    │ POST /api/auth/device/start ────▶│                             │
    │                                  │ POST github.com/login/device/code
    │                                  │ ◀────────────────────────── │
    │ ◀── verification_uri, user_code ─│                             │
    │                                                              │
    │ user opens verification_uri, enters user_code in browser ──▶ │
    │                                                              │
    │ poll loop ──▶ /api/auth/device/poll                            │
    │                                  │ POST oauth/access_token     │
    │                                  │ ◀── access_token ─────────  │
    │                                  │ GET api.github.com/user     │
    │                                  │ ◀── { login, id, email } ── │
    │                                  │ upsert publishers, mint session
    │ ◀── { token, github_login } ─────│                             │
```

- Server stores GitHub access tokens only long enough to fetch the GitHub user profile; never persists them.
- Session tokens are 32-byte random, hashed (sha256) in DB, 30-day TTL.
- Local app stores the community session token in the configured local auth directory (`DESIGN_VAULT_COMMUNITY_AUTH_DIR`) or `.local/community-auth/auth.json` mode `0600`. That path is ignored and **not** in the repo.

## 6. Bundle integrity

- On `POST /api/submissions`: server computes sha256 of uploaded bundle, re-extracts it to a sandbox dir, parses `submission.json`, validates `bundleFormatVersion`, asserts every field present, checks `originHost.appRoot` is non-empty (Phase 1 contract). Rejects on any check failure with a useful error.
- On approve: bundle file is renamed from `bundles/incoming/<sha256>.tgz` to `bundles/published/<slug>/v<n>-<sha256>.tgz`.
- On download: `etag = "<sha256>"`, `cache-control: public, max-age=3600`. Clients can short-circuit if they have it.

## 7. Cross-machine path rewrite

Phase 1 already solves this: the bundle ships `submission.json.originHost.appRoot` (inferred from `meta.designPath`), and `installBundle` rewrites every JSON file under the install dir, substituting `originHost.appRoot → APP_ROOT` and renaming `/designs/<upstreamSlug>/` → `/designs/community-<upstreamSlug>/`.

Phase 2 only needs to **trust** that contract — server never modifies bundle contents, just stores and serves.

## 8. Local client extensions

In the existing app (no new package, additive):

| File | What it adds |
|---|---|
| `src/lib/community.ts` | `publishToServer(slug, baseUrl, token)` — uses existing `bundleDesign`, then `POST /api/submissions`. |
| `src/lib/community-client.ts` (new) | Device flow helper, local session token store, `fetchRegistry`, `downloadBundle`. |
| `src/components/CommunityBrowser.tsx` (new) | Tab in HomeLibrary: search/filter approved registry, "Install" button per card. |
| `src/app/api/community/install/route.ts` | Extend: accept `{ remoteSlug, baseUrl }` to download then install in one call, in addition to current multipart path. |

Settings UI gets a "Community server" panel: base URL, login state, logout button.

## 9. Trust model

| Risk | Mitigation |
|---|---|
| Malicious bundle ships path-traversal in `submission.json` | `installBundle` already only writes under `community-<slug>/`. Server also rejects manifests with `..` or absolute paths inside `bundle_path`. |
| Mass-submitted spam | Rate limits + admin queue + per-publisher daily cap + admin can ban. |
| Copyright takedown | Admin can mark approved → `retracted` with public reason. Clients see "removed" in next registry sync. |
| Server compromise | Bundles are read-only after approval (filesystem chmod 0444). Postgres role for app has no DDL. Caddy fronts everything; no Postgres or fs paths exposed. |
| Lost admin access | Admin allowlist is env-driven; can be edited via SSH + `docker compose restart community-server`. |
| Token theft on user laptop | 30-day TTL, server `/api/auth/logout`, revoke all sessions endpoint for admin. |

## 10. Deferred to Phase 3+

- Auto "update available" detection in local UI (compare local meta version vs registry).
- Multi-version retention and rollback.
- Notification on approval (email or browser push).
- Search index (Postgres full-text on title/summary/tags is fine for now; OpenSearch only if catalog crosses ~10k entries).
- Public read-only browse on the web (currently only local clients consume the registry).
- License variants: `cc-by-4.0`, `mit`, `custom`. Phase 2 ships with `research-only` default.

## 11. Open questions for the user before code

- **Bundle visibility.** Do approved bundles need to be downloadable by anyone with the URL (current design), or only by logged-in publishers? My recommendation: anyone, since the whole point is frictionless reuse and the content is already derived from public web sources.
- **License default.** `research-only` is opaque legally; do you want me to swap to "CC BY-SA 4.0" with attribution back to `submission.publisher.login`?
- **Account deletion.** GDPR-style "delete my publisher account" — should bundles stay (with publisher anonymized) or also retract? Default plan: stay, anonymize.

Answer when convenient; current defaults are codified above.
