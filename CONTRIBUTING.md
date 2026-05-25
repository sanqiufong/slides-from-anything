# Contributing to Slides from Anything

Thanks for helping improve Slides from Anything. This project integrates the
OpenPPT/SFA slide runtime with Design Vault so users can run the real product UI
locally, install or import design systems, and create slide decks from source
material.

## Ground Rules

- Keep the project open-source safe: do not commit API keys, local `.env` files,
  generated projects, logs, databases, or private template bundles.
- Keep software assets and private user assets separate. Framework images and UI
  assets required by the app belong in the source tree; downloaded templates and
  user data belong in ignored runtime directories.
- Use `pnpm tools-dev` for local lifecycle work. Do not add root aliases such as
  `pnpm dev`, `pnpm start`, `pnpm test`, or `pnpm build`.
- Keep new project-owned entrypoints and tests TypeScript-first.
- Do not add `Co-authored-by` trailers or other co-author metadata to commits.

Read `AGENTS.md` before changing repository structure, package boundaries, or
local lifecycle commands.

## Local Setup

```bash
corepack enable
pnpm install
OPEN_IN_BROWSER=0 ./scripts/start-integrated.sh
```

The integrated launcher starts:

- SFA / OpenPPT UI: `http://127.0.0.1:5173`
- Design Vault UI: `http://127.0.0.1:3217`

For OpenPPT/SFA-only development:

```bash
pnpm tools-dev run web --daemon-port 17456 --web-port 5173
```

## What To Contribute

Good contributions usually fall into one of these areas:

- Fixes to the SFA/OpenPPT web experience in `apps/web`.
- Daemon, vault bridge, preview, asset, or update-check fixes in `apps/daemon`.
- Design Vault integration fixes in `apps/design-vault`.
- Shared API contract changes in `packages/contracts`.
- Runtime lifecycle improvements in `tools/dev` or packaging work in
  `tools/pack`.
- Documentation that reflects this project, not upstream marketing copy.

## Data Boundary

The following should stay out of git:

- `.tmp/`
- `.od/`
- `apps/design-vault/data/*` except `.gitkeep`
- `skills/dv-*`
- `design-systems/dv-*`
- local `.env` files
- generated logs, databases, project artifacts, and downloaded template bundles

When using `scripts/start-integrated.sh`, Design Vault runtime data lives under:

```text
.tmp/integrated/design-vault-data
```

## Validation

Run at least:

```bash
pnpm guard
pnpm typecheck
```

Then run package-scoped checks for the files you changed:

```bash
pnpm --filter @open-design/web test
pnpm --filter @open-design/daemon test
pnpm --filter design-vault build
```

The `@open-design/*` package names are still the current workspace package
identifiers. Renaming them is a separate compatibility migration and should not
be mixed into unrelated changes.

## Documentation

The maintained root docs are:

- `README.md`
- `README.zh-CN.md`
- `QUICKSTART.md`
- `CONTRIBUTING.md`
- `CONTRIBUTING.zh-CN.md`

Avoid adding translated copies unless they are actively maintained for this
project.
