# Architecture

Slides from Anything is a pnpm workspace that runs two real applications
together:

- OpenPPT/SFA web runtime and daemon.
- Design Vault template and design-system manager.

The integration is local-first. It starts both apps on loopback ports and uses
ignored runtime directories for user data.

## Local Topology

```text
browser
  |
  | http://127.0.0.1:5173
  v
apps/web  <---- /api/* proxy ---->  apps/daemon
                                      |
                                      | vault bridge
                                      v
apps/design-vault  <---------------- http://127.0.0.1:3217
```

The integrated launcher sets the key runtime variables:

```bash
OPENPPT_WEB_PORT=5173
OPENPPT_DAEMON_PORT=17456
DESIGN_VAULT_PORT=3217
DESIGN_VAULT_DATA_DIR=.tmp/integrated/design-vault-data
OPENPPT_VAULT_DESIGNS_DIR=.tmp/integrated/design-vault-data/designs
OPENPPT_VAULT_ORIGIN=http://127.0.0.1:3217
```

## Main Components

### `apps/web`

The Next.js App Router runtime for SFA/OpenPPT. It owns the browser UI, project
workspace, Design Vault tab, preview workbench, update settings, and daemon API
client code.

### `apps/daemon`

The local API process. It owns project persistence, vault template listing,
preview and asset routes, update checks, agent/runtime orchestration, and static
serving for generated artifacts.

### `apps/design-vault`

The embedded Design Vault application. It imports URLs and design-system
projects, creates template records, downloads community packages, and stores
runtime design data in the configured `DESIGN_VAULT_DATA_DIR`.

### `apps/desktop` and `apps/packaged`

Electron shell and packaged runtime entries. These are thin wrappers around the
same web/daemon runtime and use sidecar IPC to discover status and URLs.

### `packages/contracts`

Pure TypeScript shared contracts for web/daemon request and response shapes.

### `packages/sidecar-proto`, `packages/sidecar`, `packages/platform`

Sidecar and process primitives. Their package names still use the
`@open-design/*` workspace namespace for compatibility. Treat renaming that
namespace as a separate migration.

### `tools/dev`

The local lifecycle control plane exposed through `pnpm tools-dev`.

### `tools/pack`

The packaged build/start/stop/logs control plane for macOS, Windows, and Linux.

## Data Layout

Source-controlled software lives in the workspace. Runtime data does not.

Ignored runtime locations include:

```text
.tmp/
.od/
apps/design-vault/data/*
skills/dv-*
design-systems/dv-*
```

The integrated launcher writes Design Vault templates to:

```text
.tmp/integrated/design-vault-data
```

## Vault Asset Flow

1. Design Vault creates or installs a design record.
2. SFA daemon reads the configured Vault designs directory.
3. SFA rewrites preview HTML asset URLs so installed templates resolve through
   the current local slug.
4. The web UI renders the template preview and deck workflow without requiring
   the source template bundle to be committed.

## Validation

At minimum:

```bash
pnpm guard
pnpm typecheck
```

Run package-scoped tests/builds for the touched area.
