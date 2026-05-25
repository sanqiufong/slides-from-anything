# Changelog

All notable changes to Slides from Anything are documented here.

This project follows semantic versioning from the public integration baseline.

## [Unreleased]

## [1.0.0] - 2026-05-25

Initial open-source integration release.

### Added

- Integrated the real OpenPPT/SFA web runtime with the real Design Vault UI.
- Added `scripts/start-integrated.sh` and `启动集成项目.command` to launch both
  applications together.
- Added isolated Design Vault runtime data under
  `.tmp/integrated/design-vault-data`.
- Added Vault template sync, preview, asset serving, and local install flow
  through the SFA daemon.
- Added update-check metadata beginning at `v1.0.0` through
  `releases/stable.json` and `/api/updates/check`.

### Changed

- Reworked root README documentation for the Slides from Anything project.
- Replaced stale upstream root docs with project-specific docs.
- Disabled neighboring `../design-vault` template auto-import by default.

### Security

- Kept private template downloads, generated projects, local databases, logs,
  and API credentials outside source control.
- Preserved only software/framework assets needed for the application to run.
