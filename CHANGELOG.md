# Changelog

All notable changes to Slides from Anything are documented here.

This project follows semantic versioning from the public integration baseline.

## [Unreleased]

## [1.0.1] - 2026-05-29

### Changed

- Use PPT title-slide previews as Design Vault template covers across the
  library, project setup, question form, and chat Vault context surfaces.
- Carry the focused PPT preview dimensions through iframe scaling so slide
  covers render as native 16:9 templates instead of web-derived cards.

### Fixed

- Removed the top and bottom whitespace around focused PPT preview slides while
  preserving each slide's original internal layout rules.

## [1.0.0] - 2026-05-25

Initial open-source integration release.

### Added

- Integrated the real OpenPPT/SFA web runtime with the real Design Vault UI.
- Added `scripts/start-integrated.sh` and `start.command` to launch both
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
