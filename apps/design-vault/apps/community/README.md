# @design-vault/community-server

The server side of Phase 2. Holds the registry of approved Design Vault systems, accepts publisher submissions through GitHub OAuth, and runs the single-person admin review queue.

Design contract: see [docs/PHASE2.md](../../docs/PHASE2.md). Runtime config: see [deploy/.env.example](../../deploy/.env.example).

## Local dev (against a Postgres in docker)

```bash
# from repo root
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d postgres

# then in apps/community/
pnpm install
DATABASE_URL=postgres://design_vault:<your-password>@localhost:5432/design_vault \
PUBLIC_BASE_URL=http://localhost:3300 \
BUNDLE_STORAGE_ROOT=/tmp/dv-bundles \
GITHUB_CLIENT_ID=<id> GITHUB_CLIENT_SECRET=<secret> \
ADMIN_GITHUB_LOGINS=<your-github-login> \
SESSION_SECRET=$(openssl rand -base64 48) \
pnpm dev
```

Visit http://localhost:3300 for the public landing, http://localhost:3300/admin for the queue (will redirect to GitHub OAuth).

## Production

Built and run by `deploy/docker-compose.yml` with the `app` profile. See `deploy/README.md`.

## API

All routes documented in `docs/PHASE2.md §4`. Quick reference:

- `GET  /api/health`
- `GET  /api/me`
- `POST /api/auth/device/start`
- `POST /api/auth/device/poll`
- `GET  /api/auth/github/callback` (web OAuth)
- `POST /api/auth/logout`
- `GET  /api/registry?tag=&q=&since=`
- `GET  /api/registry/<slug>`
- `GET  /api/registry/<slug>/bundle` (streams .tgz)
- `POST /api/submissions` (multipart, bearer auth)
- `GET  /api/submissions/mine` (bearer auth)
- `GET  /api/admin/submissions?status=pending` (admin)
- `POST /api/admin/submissions/<id>/approve` (admin)
- `POST /api/admin/submissions/<id>/reject` (admin)
