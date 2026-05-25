# Roadmap

This roadmap starts from the `v1.0.0` public integration baseline.

## v1.0.0 Baseline

- Real OpenPPT/SFA web runtime.
- Real Design Vault UI.
- Integrated launcher for both applications.
- Isolated Design Vault runtime data under `.tmp/integrated/`.
- SFA Vault tab connected to installed Design Vault templates.
- Preview and asset rewriting for installed community templates.
- Update-check manifest and daemon endpoint.
- Root README and Chinese README written for this project.

## Near Term

- Continue removing stale upstream documentation that does not describe this
  project.
- Harden template sync and deletion flows across SFA and Design Vault.
- Add focused tests for downloaded-template asset paths, preview slugs, and
  runtime data isolation.
- Improve first-run diagnostics for Node/pnpm, port conflicts, and missing
  Design Vault runtime data.
- Refresh package-level docs so they describe Slides from Anything while
  preserving current workspace package names.

## Packaging

- Verify packaged macOS, Windows, and Linux builds after the integration rename.
- Ensure product names, app icons, installer metadata, and update feeds all use
  Slides from Anything.
- Keep runtime paths namespace-scoped and independent from daemon/web ports.

## Compatibility Migration

The workspace still contains `@open-design/*` package names and sidecar constant
names. They are compatibility identifiers, not product branding. Renaming them
will require a separate migration touching package manifests, imports, tests,
packaging resources, sidecar stamps, and runtime path compatibility.

## Later

- Hosted release manifest and signed update channel.
- Better community template browsing and conflict handling.
- More e2e coverage for the integrated UI.
- Documentation site generated from the maintained docs set.
