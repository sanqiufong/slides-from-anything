# Slides from Anything Product Spec

**Status:** v1.0.0 public integration baseline
**Scope:** Product definition, supported user flows, runtime boundaries, and
open-source release constraints for the OpenPPT + Design Vault integration.

Related docs:

- Architecture: [`architecture.md`](architecture.md)
- Update service: [`update-service.md`](update-service.md)
- OpenPPT hardening: [`openppt-architecture-notes.md`](openppt-architecture-notes.md)
- Design Vault output requirements: [`design-vault-style-output-requirements.md`](design-vault-style-output-requirements.md)

## Product In One Sentence

Slides from Anything is a local-first workspace that lets users run OpenPPT/SFA
and Design Vault together, install or import design systems, and create slide
decks from source material through the real product UI.

## Core Goals

1. **Run the real UI.** Users should land in the OpenPPT/SFA interface and the
   real Design Vault interface, not a hand-written mock shell.
2. **Share local templates safely.** Templates installed in Design Vault should
   be selectable from SFA without copying private template payloads into git.
3. **Preserve software assets.** Framework images, icons, and UI assets required
   by the application stay in source control.
4. **Keep private data out.** Downloaded templates, generated projects, logs,
   databases, `.env` files, and credentials remain in ignored runtime paths.
5. **Make updates explicit.** The app exposes version metadata from `v1.0.0`
   onward and can check a hosted release manifest.

## Primary User Flows

### F1. Start The Integrated App

The user runs `./启动集成项目.command` or
`./scripts/start-integrated.sh`. The launcher:

- installs workspace dependencies,
- clears stale local listeners,
- starts Design Vault on `127.0.0.1:3217`,
- starts OpenPPT/SFA on `127.0.0.1:5173`,
- connects the SFA daemon to the Design Vault runtime data directory.

### F2. Install Or Import A Design System

The user opens Design Vault, installs a community template, imports a URL, or
creates a local design system. The generated runtime data is stored under:

```text
.tmp/integrated/design-vault-data
```

### F3. Create A Deck In SFA

The user returns to SFA, opens the Design Vault tab, syncs/selects a template,
and creates a slide deck. Preview and asset routes must resolve local template
assets after installation.

### F4. Check For Updates

The app can call `/api/updates/check`. The default release manifest lives at
`releases/stable.json`; deployments can override it with
`SFA_UPDATE_MANIFEST_URL`.

## Non-Goals

- Do not ship a personal local template library as source code.
- Do not auto-import templates from neighboring checkouts unless explicitly
  enabled by the user.
- Do not add root lifecycle aliases such as `pnpm dev`, `pnpm start`,
  `pnpm test`, or `pnpm build`.
- Do not rename workspace packages or sidecar constants casually; that is a
  separate compatibility migration.

## Open-Source Release Requirements

The repository must remain safe to publish:

- no API keys,
- no private `.env` files,
- no generated databases or logs,
- no downloaded/private Design Vault bundles,
- no personal project artifacts,
- no accidental imports from sibling local repositories.

The app-specific source assets needed to run the software should remain tracked.
