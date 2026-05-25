# apps/packaged

Thin packaged Electron runtime entry for Slides from Anything.

This package starts the packaged daemon and web sidecars, registers the `od://`
entry protocol, and then delegates to `@open-design/desktop/main` for the host
window. Product logic stays in `apps/daemon`, `apps/web`, and `apps/desktop`.
