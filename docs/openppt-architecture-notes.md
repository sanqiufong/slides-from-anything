# OpenPPT Architecture Notes

## Product Direction

OpenPPT is a specialized visual agent for building PPT / Web-PPT decks. Open Design provides the product shell, local daemon, project persistence, agent run pipeline, SSE streaming, and file workspace. Open Slide provides the canonical deck authoring contract and editing workbench model. Design Vault provides reusable visual templates and design-language evidence.

The canonical source is Web-PPT: `slides/<slideId>/index.tsx`. PPTX is a derived export path, not an editable source of truth.

## Source Projects

### Open Design

Kept as the base:

- monorepo layout and `pnpm tools-dev`
- daemon/web sidecar flow
- SQLite project/conversation/message/tabs persistence
- `.od/projects/<projectId>` project folders
- local agent detection and run streaming
- project file APIs and file watcher events
- chat composer, message persistence, and preview-comment attachment pattern

Removed or narrowed in the product surface:

- prototype/image/video/audio/live-artifact creation paths are no longer primary entry flows
- Design Systems browsing is replaced by Design Vault templates
- deck generation should not produce legacy HTML deck artifacts

### Open Slide

Absorbed as an internal workbench direction, not as an iframe to the original repo.

Important contracts:

- slide module exports `design: DesignSystem`, `meta: SlideMeta`, and default `Page[]`
- fixed 1920x1080 page canvas
- assets live under `slides/<slideId>/assets/`
- comment markers use `@slide-comment` in JSX comments
- editing surfaces map to source: thumbnail rail, slide canvas, design panel, inspector panel, comment widget, export menu

OpenPPT now owns daemon adapters for the behaviors Open Slide previously served through `virtual:open-slide/*`, `/__design`, `/__edit`, `/__comments`, and local slide assets.

#### Open Slide parity audit

Open Slide's "smooth" feel is not just its canvas. It is the combination of these pieces:

- `routes/slide.tsx` owns the full shell: title bar, slides/assets tabs, inline title edit, export dropdown, Design toggle, Inspect toggle, Present button, desktop rail, mobile rail, canvas, click navigation zones, `SaveBar`, `CommentWidget`, `InspectorPanel`, and `DesignPanel`.
- `SlideCanvas` is a fixed 1920 x 1080 stage that uses `ResizeObserver` to fit the viewport and applies `DesignSystem` tokens as CSS variables.
- `ThumbnailRail` renders each real Page component inside a scaled `SlideCanvas`, so browsing is visual and faithful rather than a text list.
- `Player` is a true presentation mode with keyboard navigation, touch/wheel navigation, progress, jump input, blackout, laser pointer, overview, help overlay, and presenter-window channel.
- `InspectOverlay` works against real DOM, not parsed source summaries. It finds `[data-slide-loc]`, highlights the exact element rectangle, and keeps the selection attached while layout changes.
- `InspectorProvider` buffers text/style/asset edits, mutates the selected DOM optimistically, then commits a batch to `/__edit/batch`.
- `CommentWidget` and `/__comments` persist JSX `@slide-comment` markers, which are later applied by the slide-comment skill or by an agent turn.
- The Vite `loc-tags` plugin injects `data-slide-loc="<line>:<column>"` into JSX elements under `slides/<slideId>/index.tsx`. Without this transform, Inspect cannot map clicks back to source safely.

This means OpenPPT must migrate the runtime boundary, not approximate it with static previews. The minimum acceptable workbench loop is:

1. Load `slides/<slideId>/index.tsx`.
2. Inject `data-slide-loc`.
3. Compile/evaluate the module into real React `Page[]`.
4. Render the active Page in a 1920 x 1080 `SlideCanvas`.
5. Render visual thumbnails from the same Page components.
6. Let Inspect select real DOM elements and record line/column/semantic label.
7. Insert `@slide-comment` and a `slide_feedback` row.
8. Attach that feedback to the next chat turn or immediately trigger an agent run.
9. Re-read the source after the agent changes it and re-render from the same canonical file.

The current OpenPPT implementation now covers steps 1-8 for the first product slice. It still needs Open Slide's full rich editor parity: optimistic text/style edits, batched `/__edit` operations, asset replacement UI, real HTML/PDF export from the rendered deck, and the full presentation control set.

### Design Vault

Design Vault remains an independent local service. OpenPPT accesses it through daemon proxy endpoints so the web app does not couple directly to a second origin.

Important Design Vault API shape:

- `GET /api/designs`
- `GET /api/designs/:slug`
- `GET /api/designs/:slug/preview?kind=web|ppt`
- `POST /api/ingestions`
- `GET /api/jobs/:jobId`

Vault `open-slide-theme.md` is treated as authoritative style input when a deck is created from a template.

#### Vault template as chat-time style decision

Style template selection belongs in the conversation, not in the new-project form. At project creation time the user usually has not explained the subject, audience, content density, or desired narrative arc yet, so a template picker there is premature.

The create panel now starts a blank OpenPPT deck and marks visual style as "choose in chat". The agent should first collect task-fit information, then recommend matching Vault templates with reasons, then ask the user to choose.

When a Vault template is eventually selected in chat, OpenPPT should store a rich `metadata.vaultTemplate` snapshot on the project:

- `title`, `slug`, source URL/domain, summary, archetype, and local design paths
- `visualThesis`
- `colorRoles`
- `openSlideGuidance`
- `openSlideThemePath`

The daemon uses a selected snapshot in three places:

1. Seed `slides/<slideId>/index.tsx` with Vault-derived palette tokens instead of the default OpenPPT palette.
2. Read the selected template's `open-slide-theme.md` and inject it into the deck system prompt as the active authoritative style guide.
3. Lock visual-style discovery. If `metadata.vaultTemplate` or an active design-system block exists, the agent must not ask the user to choose visual tone, brand style, color direction, or similar style-direction fields. Clarifying questions should focus on missing narrative, audience, content, scope, or business constraints.

If a deck has no `metadata.vaultTemplate`, the daemon injects a compact Design Vault catalog into the system prompt. The agent should use discovery answers to recommend 2-3 candidate templates, explaining task fit, audience fit, content fit, and visual fit. Only if the catalog is unavailable should it fall back to generic visual-style questions.

Current interim behavior: the selected template is understood from the conversation and the agent can read the chosen `openSlideThemePath`. A follow-up implementation should persist the chat-selected template back to `metadata.vaultTemplate` so future turns show it as locked without relying on conversation history.

## Current Implementation Slice

### Contracts

Project metadata now supports deck-specific fields:

- `kind: "deck"`
- `slideId`
- `slideWorkspace`
- `vaultTemplate`
- `deliveryOptions`

Chat request/message contracts now support `slideFeedbackAttachments`, parallel to preview comment attachments.

Vault contracts were added for design metadata and ingestion jobs.

### Daemon

New Vault proxy:

- `GET /api/vault/designs`
- `GET /api/vault/designs/:slug`
- `GET /api/vault/designs/:slug/preview?kind=web|ppt`
- `POST /api/vault/ingestions`
- `GET /api/vault/jobs/:jobId`

New OpenPPT slide adapter:

- ensures deck projects have `slides/<slideId>/index.tsx`
- reads slide source and parsed comment markers
- applies line-based source edits
- reads/writes `export const design`
- inserts/deletes `@slide-comment` markers
- lists slide-local assets

The daemon also serves the built web app with an SPA fallback, so project deep links such as `/projects/<id>/files/slides/<slideId>/index.tsx` can be refreshed or shared without returning a static 404.

Fresh deck creation seeds `slides/<slideId>/index.tsx` as hidden working state only. It must not persist that seed file as the active open tab; the UI should stay on Design Files / chat until the agent writes or edits the deck, at which point the existing Write/Edit auto-open flow focuses the generated slide source.

New `slide_feedback` table:

- statuses: `queued`, `applying`, `needs_review`, `applied`, `dismissed`, `failed`
- kinds: `comment`, `design-token`, `inspect-edit`, `semantic-edit`

Chat composition now includes `<attached-slide-feedback>` so queued slide feedback enters agent context.

### Web

Entry page is narrowed toward PPT:

- New Project defaults to deck
- visible creation tab is deck only
- Design Vault template picker replaces design-system picker in the create flow
- main browse tabs are PPT Projects and Design Vault
- project list is filtered to deck projects

The project workspace recognizes OpenPPT slide files (`slides/<slideId>/index.tsx`) and opens a first Open Slide workbench pane with:

- daemon-compiled slide module runtime
- `data-slide-loc` injection for source-mapped Inspect selection
- real React `Page[]` rendering on a 1920 x 1080 canvas
- visual thumbnail rail rendered from the same Page components
- lightweight Present overlay with keyboard navigation
- design token color controls writing through daemon adapter
- inspect click-to-select, source line/column capture, and feedback input
- comment creation that inserts `@slide-comment` and queues `slide_feedback`
- immediate "Trigger agent" path that sends the selected feedback as a chat attachment
- export actions for archive/PPTX path

The project view now stacks chat and workbench vertically on narrow viewports. Desktop keeps the side-by-side authoring layout; mobile and half-width windows avoid horizontal overlap by putting the Open Slide workbench below the conversation.

### Runtime Module Adapter

`GET /api/projects/:id/open-slide/module?slideId=<slideId>` compiles a slide source file for browser execution:

- reads `.od/projects/<projectId>/slides/<slideId>/index.tsx`
- injects `data-slide-loc` into lower-case JSX tags and `ImagePlaceholder`
- uses TypeScript `transpileModule` to emit CommonJS JavaScript
- returns `{ slideId, path, code, diagnostics, comments }`

The web workbench evaluates this local project code with a restricted require shim:

- `react` resolves to the app's React instance
- `@open-slide/core` currently exposes an `ImagePlaceholder` stub for generated decks
- `./assets/<file>` resolves to the daemon raw asset endpoint

This is an interim bridge. The long-term target is a first-class package-level Open Slide runtime inside `packages/open-slide-workbench`, but this adapter preserves the canonical source and gives the UI real Page rendering immediately.

### Internal Package

`packages/open-slide-workbench` defines the internal productized Open Slide workbench boundary:

- `OpenSlideWorkbench`
- thumbnail rail / stage / inspector / feedback / export slots
- typed source and action interfaces

This package is the intended place to migrate real Open Slide components into as the shell matures.

### Agent Skill

`skills/openppt-deck/SKILL.md` is the default deck skill. It instructs agents to edit Open Slide TSX directly and avoid legacy HTML deck artifact output.

The shared system prompt now injects the OpenPPT deck contract for `metadata.kind === "deck"` instead of the old HTML deck framework.

### Motion Standard

OpenPPT treats subtle slide motion as part of the Open Slide product feel, not as optional decoration:

- Every generated deck should define lightweight helpers for `fadeUp`, `lineGrow`, `stagger`, and `canvasSwap`, implemented with local CSS animation inside the slide module.
- Every page should use restrained entrance motion in preview and present mode; static hard cuts are allowed only when the user asks for a static or reduced-motion deck.
- Thumbnail and still-preview contexts pass `data-osd-freeze-motion` and must render the final visual state, so animated elements cannot disappear in rails, overview, or frozen previews.
- The deck skill and injected contract both require preserving existing motion helpers during semantic edits.

## Execution Model

1. User creates a deck from the OpenPPT entry panel.
2. Daemon seeds `.od/projects/<id>/slides/<slideId>/index.tsx`.
3. User chats with a local agent.
4. Agent reads/writes the slide module directly.
5. OpenPPT workbench reads the same source through daemon adapter APIs.
6. User changes design tokens or adds inspect feedback.
7. Feedback is queued in `slide_feedback`.
8. User can send feedback immediately or include it automatically in the next agent turn.
9. Web-PPT remains editable; HTML/PDF/PPTX are export paths.

## Next Implementation Priorities

1. Port Open Slide `InspectorProvider`, `InspectorPanel`, `InspectOverlay`, and `/__edit/batch` semantics so selected elements can be text/style/asset edited with optimistic preview and source commit.
2. Port the full Open Slide `Player` controls: fullscreen, overview, blackout, laser pointer, presenter window, jump input, and help overlay.
3. Replace the current Design token mini-panel with the Open Slide `DesignPanel` behavior, including draft/commit/discard/reset and live CSS variable overlay.
4. Upgrade thumbnails to reuse the exact Open Slide `ThumbnailRail` ergonomics, including active scroll, mobile rail, and folder/assets affordances.
5. Make feedback queue visible in ChatPane and allow per-item attach/dismiss/apply before send.
6. Add a chat-time "choose / bind / replace Vault template" path that writes the selected template back to `metadata.vaultTemplate`.
7. Add deterministic HTML/PDF export from rendered slide source.
8. Keep PPTX export as an agent-driven menu action until a deterministic converter is available.

## Test Checklist

- `pnpm typecheck`
- daemon route smoke tests for Vault proxy and slide adapter
- create deck project and verify `slides/<slideId>/index.tsx`
- run a real local-agent generation and verify the seed slide module is replaced by a multi-page deck
- open project and verify workbench renders instead of plain file viewer
- verify `/api/projects/:id/open-slide/module` returns compiled code with `data-slide-loc`
- verify real `Page[]` renders in the workbench, thumbnails, and Present overlay
- click a canvas element with Inspect enabled and verify line/column + target label populate
- edit design token and verify file changes
- add inspect feedback and verify `slide_feedback` row/status
- trigger agent from selected feedback and verify the feedback is attached to the user message
- send chat turn and verify feedback appears in `<attached-slide-feedback>`
- desktop and narrow viewport visual pass for entry, Vault tab, and workbench

## Production QA Notes - 2026-05-08

The current `http://127.0.0.1:7457/` build was revalidated with headless Chrome after the Open Slide workbench integration.

Passed coverage:

- Entry page title/branding, PPT-only create flow, Vault template cards, Vault search, Vault selection, and immediate create-button enablement.
- Project list grid/kanban toggles, project search, avatar menu, settings modal open/close, and archive export API.
- Design Vault tab, template list loading, search filtering, ingest form enabled state, and `web`/`ppt` preview routes.
- Desktop Open Slide workbench: runtime `Page[]` render, thumbnail rail, Prev/Next, Present overlay keyboard navigation, Inspect source selection, feedback queue persistence, `@slide-comment` insertion, design-token write-through, and chat send.
- Narrow viewport at 848 px: entry page stacks side/main content at full width; project chat/workbench stacks vertically; toolbar/stage have no horizontal overflow.
- Daemon slide module route returns compiled code with zero diagnostics and injected `data-slide-loc`.

Fixes from this pass:

- Project split now stacks at `max-width: 1100px`, not only phone widths, so tablet/half-window workbench previews are not squeezed.
- Entry sidebar responsive override now clears the resizable sidebar max-width, making the create form full-width on narrow screens.
- Create button no longer depends on unrelated parent workspace loading when the visible PPT form itself is ready.

Validation commands used:

- `pnpm --filter @open-design/web typecheck`
- `pnpm --filter @open-design/web build`
- `pnpm --filter @open-design/daemon typecheck`
- `pnpm --filter @open-design/daemon build`

Known validation nuance: for color-token controls, use a real browser input interaction (`fill`/user change) rather than manually dispatching DOM events; React's color input handler may not run from synthetic event injection alone.

## Workbench Container Rebuild - 2026-05-08

The OpenPPT project page now treats the Open Slide workbench as the primary container instead of a simplified side panel:

- The deck workspace shell mirrors Open Slide's core layout: 48px editorial toolbar, Slides/Assets tabs, centered title + folio, export menu, Design/Inspect toggles, Present action, vertical thumbnail rail, mobile rail, and a centered 1920 x 1080 paper canvas.
- `OpenSlideCanvas` now follows the Open Slide scale contract more closely: fit-to-container `ResizeObserver`, optional fixed scale for thumbnails/overview, centered or top-left modes, flat mode for player/thumbnail surfaces, `data-osd-canvas`, and frozen-motion support.
- Inspect is a mode, not a permanent right column. When enabled, canvas clicks select injected `data-slide-loc` elements, populate line/column/target label, and expose Queue / Trigger agent feedback actions. Feedback still routes through OpenPPT's `slide_feedback` + chat attachment path.
- Design is a separate overlay panel with token controls and export links. Inspect and Design are intentionally mutually exclusive in this integration to avoid stacked right panels in the embedded OpenPPT split view.
- The comments affordance moved back onto the canvas as a bottom-right widget, matching Open Slide's "work inside the paper" interaction model while keeping OpenPPT's queued-feedback apply button.
- Present now uses an Open Slide-like full-screen overlay with click zones, keyboard navigation, progress bar, controls, overview, blackout, whiteout, laser, elapsed time, and help overlay.

Validation from this pass:

- `pnpm --filter @open-design/web typecheck`
- `pnpm --filter @open-design/web build`
- daemon restart on `http://127.0.0.1:7457/`
- 15-page deck check on `8bf4725a-e18a-4496-adea-5d0d852a7575`: rail buttons = 15, diagnostics = 0, injected main-canvas `data-slide-loc` exists, Inspect selection populates `56:4`, Queue / Trigger agent enable after feedback text, Design opens 3 token controls, Present overlay exposes controls + progress.

One slide-source repair was also applied to that project: an `@slide-comment` marker had been inserted inside a JSX `style={{ ... }}` object, causing parse diagnostics. The marker was moved outside the style object and duplicate `fontSize` in one style object was normalized, restoring compiled module diagnostics to zero.

## Embedded Design Vault Integration - 2026-05-10

OpenPPT now treats Design Vault as an embedded product capability rather than a required side service.

- The default Vault catalog root is `design-vault/data/designs` inside the OpenPPT repo. `OPENPPT_VAULT_DESIGNS_DIR` can override it, and `OD_RESOURCE_ROOT/design-vault/data/designs` is used in packaged builds.
- `/api/vault/designs`, `/api/vault/designs/:slug`, preview routes, and asset routes are local-first. External `OPENPPT_VAULT_ORIGIN` is optional and only used when explicitly configured.
- Only usable design folders are listed: a folder must have `meta.json`, context files, a skill entry, or a local preview. Incomplete capture directories are filtered out so the UI does not show JSON error cards.
- Skill packages such as `guizang-ppt-skill-test` and `tabler-tabler-test` resolve `SKILL.md`, `capabilities.json`, and references from the embedded OpenPPT tree. Copied absolute paths from the original Design Vault snapshot are rewritten at prompt/materialization time.
- Prompt contexts such as Phantom, Redis, Quinn, ASTRODITHER, and VCASS resolve `design.md`, `open-slide-theme.md`, `tokens.json`, `profile.json`, and preview assets locally.
- `tools-pack` now bundles `design-vault/` into `OD_RESOURCE_ROOT`, so packaged OpenPPT keeps template cards, previews, skills, and prompt contexts without needing `http://127.0.0.1:3217`.
- The Design Vault tab shows an embedded-catalog banner when no live ingestion worker is configured, preventing the old `Design Vault unavailable: fetch failed` user path.

Validation from this pass:

- `pnpm --filter @open-design/daemon typecheck`
- `pnpm --filter @open-design/daemon build`
- `pnpm --filter @open-design/web typecheck`
- `pnpm --filter @open-design/web build`
- `pnpm --filter @open-design/tools-pack typecheck`
- `pnpm --filter @open-design/tools-pack test -- resources`
- `pnpm guard`
- `pnpm typecheck`
- API smoke: `/api/vault/status` returns `mode: embedded`, `designCount: 7`; `/api/vault/designs` returns 7 templates; `guizang-ppt-skill-test` resolves to embedded `skill/SKILL.md`; Quinn preview and asset routes return local HTML/JPEG.
- Browser smoke: Design Vault tab renders 7 template cards and one embedded-catalog banner with no `fetch failed` / `INTERNAL_ERROR` text.
