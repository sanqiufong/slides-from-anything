# Slides from Anything

**English** | [简体中文](README.zh-CN.md)

Slides from Anything is a local-first slide creation workspace that combines the
OpenPPT slide authoring/runtime stack with the Design Vault template and style
system. The goal is simple: open one project, run the real product UI, import or
install a design system, and turn source material into usable slide decks.

This repository is a software-only open-source integration. It includes the code,
framework assets, skills, prompt contexts, and runtime glue needed for the
application to work. It does not ship personal local template libraries, private
Design Vault downloads, generated projects, API keys, logs, databases, or other
machine-local runtime data.

## What is included

- OpenPPT/SFA web UI for creating slide decks from source material.
- Embedded Design Vault UI for importing, managing, and installing design
  systems/templates.
- A shared local runtime so templates installed in Design Vault can be selected
  inside the SFA slide workflow.
- Local daemon APIs for projects, vault templates, previews, assets, and update
  checks.
- Desktop and packaged-runtime scaffolding for local application distribution.
- Version/update metadata starting at `v1.0.0`.

The integration uses the real OpenPPT and Design Vault interfaces. It is not a
mock dashboard and it is not a service-only bridge.

## Requirements

- Node.js `24.x`
- Corepack
- pnpm `10.33.2` through Corepack
- macOS, Linux, or Windows with a shell capable of running the workspace scripts

```bash
corepack enable
pnpm install
```

## Quick Start

On macOS, the easiest path is the integrated launcher:

```bash
./启动集成项目.command
```

For a terminal-only launch, use:

```bash
OPEN_IN_BROWSER=0 ./scripts/start-integrated.sh
```

The launcher starts both applications and cleans up stale local listeners before
binding ports:

- SFA / OpenPPT UI: `http://127.0.0.1:5173`
- Design Vault UI: `http://127.0.0.1:3217`

Press `Ctrl+C` in the launcher terminal to stop both services.

## Daily Development

The root workspace intentionally keeps lifecycle commands narrow. Use
`pnpm tools-dev` for OpenPPT/SFA development and the integrated launcher when
you need Design Vault connected at the same time.

```bash
pnpm tools-dev run web --daemon-port 17456 --web-port 5173
pnpm tools-dev status --json
pnpm tools-dev logs --json
pnpm tools-dev stop
```

Run validation before publishing changes:

```bash
pnpm guard
pnpm typecheck
pnpm --filter @open-design/web test
pnpm --filter @open-design/daemon test
pnpm --filter design-vault build
```

## Working With Design Vault

1. Start the integrated launcher.
2. Open `http://127.0.0.1:3217`.
3. Import a design from a URL, install a community template, or create a new
   local design system.
4. Return to the SFA UI and open the Design Vault tab.
5. Sync/select the template and create a deck.

When launched through `scripts/start-integrated.sh`, Design Vault writes runtime
template data to:

```text
.tmp/integrated/design-vault-data
```

That directory is intentionally ignored by git. Downloaded community templates
and imported local templates are user/runtime data, not source-code fixtures.

Community access is configured with:

```bash
DESIGN_VAULT_COMMUNITY_BASE_URL=https://vault.aassistant.xyz
```

Model-backed imports can be configured with the variables documented in
`apps/design-vault/.env.example`, including `DESIGN_VAULT_MODEL_BASE_URL`,
`DESIGN_VAULT_MODEL_API_KEY`, and `DESIGN_VAULT_MODEL_NAME`. Do not commit real
credentials.

## Data and Privacy Boundaries

The repository is prepared for public release with a strict split between
software assets and local/private data.

Ignored local/runtime data includes:

- `.tmp/`
- `.od/`
- `apps/design-vault/data/*` except `.gitkeep`
- `skills/dv-*`
- `design-systems/dv-*`
- local `.env` files
- generated logs, databases, project artifacts, and downloaded template bundles

By default, SFA does not import templates from a neighboring `../design-vault`
checkout. That legacy behavior only turns on if you explicitly set:

```bash
OPENPPT_VAULT_IMPORT_AUTODISCOVER=1
```

Framework images and UI assets required for the software itself should stay in
the source tree. Personal content, private template payloads, and credentials
should stay in ignored runtime directories.

## Update Checks

The app version starts at `v1.0.0`. Update metadata lives in:

```text
releases/stable.json
```

The daemon exposes the local update-check endpoint through `/api/updates/check`.
For a hosted release channel, point the app at a manifest URL:

```bash
SFA_UPDATE_MANIFEST_URL=https://example.com/slides-from-anything/stable.json
```

See `docs/update-service.md` for the manifest format and release-channel
expectations.

## Repository Layout

```text
apps/web            SFA/OpenPPT Next.js web runtime
apps/daemon         local daemon APIs, vault bridge, project/runtime services
apps/design-vault   embedded Design Vault application
apps/desktop        Electron desktop shell
apps/packaged       packaged runtime entry
packages/contracts  shared TypeScript contracts
packages/sidecar*   sidecar protocol/runtime packages
tools/dev           local development lifecycle control plane
tools/pack          packaged build/start/stop tooling
skills/             source-controlled slide/design skills
design-systems/     source-controlled design-system descriptors
prompt-templates/   prompt and generation templates
releases/           update-channel metadata
docs/               architecture and operational documentation
```

## Contributing

Read `AGENTS.md` before changing repository structure or lifecycle commands.
Package-level details live in nested `AGENTS.md` files under `apps/`,
`packages/`, and `tools/`.

Useful docs:

- `QUICKSTART.md`
- `CONTRIBUTING.md`
- `docs/architecture.md`
- `docs/openppt-architecture-notes.md`
- `docs/design-vault-style-output-requirements.md`

## License

Apache-2.0. See `LICENSE`.
