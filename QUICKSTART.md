# Quickstart

[README](README.md) | [简体中文](README.zh-CN.md)

This guide starts the real Slides from Anything integration: the OpenPPT/SFA web
runtime plus the embedded Design Vault application.

## Requirements

- Node.js `24.x`
- Corepack
- pnpm `10.33.2` selected through Corepack
- macOS, Linux, or Windows/WSL with a shell that can run workspace scripts

```bash
corepack enable
corepack pnpm --version
pnpm install
```

The expected pnpm version is `10.33.2`.

## Start Everything

On macOS:

```bash
./启动集成项目.command
```

In a terminal without opening browser windows automatically:

```bash
OPEN_IN_BROWSER=0 ./scripts/start-integrated.sh
```

The integrated launcher starts:

- SFA / OpenPPT UI: `http://127.0.0.1:5173`
- Design Vault UI: `http://127.0.0.1:3217`

Press `Ctrl+C` in the launcher terminal to stop both services.

## Runtime Data

When started through `scripts/start-integrated.sh`, Design Vault writes imported
and downloaded templates to:

```text
.tmp/integrated/design-vault-data
```

That directory is ignored by git. It is user/runtime data, not source code.

The launcher also sets:

```bash
DESIGN_VAULT_DATA_DIR=.tmp/integrated/design-vault-data
DESIGN_VAULT_COMMUNITY_BASE_URL=https://vault.aassistant.xyz
OPENPPT_VAULT_DESIGNS_DIR=.tmp/integrated/design-vault-data/designs
```

## OpenPPT-Only Development

Use `pnpm tools-dev` for the OpenPPT/SFA side when you do not need to run Design
Vault at the same time:

```bash
pnpm tools-dev run web --daemon-port 17456 --web-port 5173
pnpm tools-dev status --json
pnpm tools-dev logs --json
pnpm tools-dev stop
```

Do not add or use root lifecycle aliases such as `pnpm dev`, `pnpm start`, or
`pnpm test`. The root lifecycle entry point is `pnpm tools-dev`.

## Validation

Run the repo-level checks before publishing changes:

```bash
pnpm guard
pnpm typecheck
```

Run package-scoped checks for the area you changed:

```bash
pnpm --filter @open-design/web test
pnpm --filter @open-design/daemon test
pnpm --filter design-vault build
```

The `@open-design/*` package names are still the current workspace package
identifiers. Do not rename them casually; that is a separate compatibility
migration.

## Common Problems

### Node version is wrong

The launcher requires Node 24. Activate Node 24 through your preferred version
manager, then run the launcher again.

### Port is already in use

The integrated launcher tries to stop stale listeners on its managed ports
before starting. If another unrelated app owns a port, set custom ports:

```bash
OPENPPT_WEB_PORT=5174 OPENPPT_DAEMON_PORT=17457 DESIGN_VAULT_PORT=3218 ./scripts/start-integrated.sh
```

### Design Vault templates are missing

Open `http://127.0.0.1:3217`, install/import a template, then return to the SFA
Design Vault tab and sync the local library.

### Community templates or model imports need credentials

Community access uses `DESIGN_VAULT_COMMUNITY_BASE_URL`. Model-backed imports
use the variables in `apps/design-vault/.env.example`. Keep real credentials in
local environment files and never commit them.
