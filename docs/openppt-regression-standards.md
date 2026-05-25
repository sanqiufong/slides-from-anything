# OpenPPT Regression Standards

This document turns the OpenPPT implementation mistakes found during product iteration into mandatory engineering rules. The operating principle is simple: the same class of problem must not ship twice.

## Zero-repeat rule

- Every user-visible regression must leave behind at least one durable guard: a code-path change, a test, a diagnostic, or a documented acceptance rule.
- Do not mark a fix done because one screenshot looks better. Verify the state that caused the bug, the adjacent path, and the persisted data behind it.
- If a workaround touches `.od/` runtime data, also fix the product code path that produced the bad runtime state.
- If a flow depends on generated TSX, always validate the compiled Open Slide module after the write.

## Source Integrity

- Queueing feedback, comments, inspector notes, or review markers must never mutate `slides/<slideId>/index.tsx`.
- Feedback belongs in `slide_feedback` and chat attachments. Source files are changed only by explicit edit/apply actions.
- Do not insert JSX comments into arbitrary line numbers. A line/column from DOM inspection is not a safe AST insertion point.
- Any legacy source-marker path must be opt-in, guarded, and followed by module diagnostics.
- After any slide source write, call `/api/projects/:id/open-slide/module?slideId=<id>` or the equivalent internal compiler and require no diagnostics before considering the edit valid.
- Do not leave `@slide-comment` markers in project sources. They are runtime scars, not canonical deck content.

## Open Slide Workbench Parity

- The OpenPPT workbench must preserve Open Slide's product feel, not approximate it with a static preview.
- Inspect mode must keep a high-opacity hover box following the pointer and a single selected box after click. Never show two persistent selection boxes for the same element.
- Selection popovers must avoid covering the selected element when screen space allows, and must clamp inside the viewport near edges.
- Design mode must shrink or rebalance the canvas like Open Slide instead of simply stacking an unrelated side panel over the workspace.
- The parameter inspector must expose locked controls as locked, not editable. If the source cannot safely change a style, the UI should communicate that state.
- Control surfaces need enough precision space. Sliders, numeric inputs, and labels must not be cramped or clipped.
- Keep the bottom status bar stable. It should show unsaved changes, queue state, readiness, and save/apply actions without causing layout jumps.
- Chat collapse/expand must use a smooth transition and must auto-expand when an agent run starts or produces user-relevant feedback.

## Presentation Runtime

- Web-PPT is the canonical source. PPTX, PDF, and HTML exports are delivery artifacts.
- Present mode must keep the user in presentation mode when using next/previous controls.
- Presentation controls should match Open Slide's mental model: previous, next, progress, elapsed time, overview, theme/background controls, laser/help, and exit.
- Each generated deck must include source-compatible motion choreography, not just unused helper definitions. When motion is allowed or requested, at least 60% of pages need applied motion markers such as `data-osd-motion-id`, `motionAttrs(...)`, `os-motion`, `os-fade-up`, `os-line-grow`, `os-canvas-swap`, or `os-motion-stagger`.
- Thumbnails freeze motion to the final visual state; preview and presentation enable restrained motion; reduced-motion users receive stable final-state rendering.
- Generated decks should not hard cut between pages unless the chosen design system explicitly asks for static transitions. The OpenPPT player should provide a restrained page-level transition so decks do not depend only on per-element entrance motion.

## Design Vault Consumption

- Design Vault is embedded OpenPPT product capability, not a required external service. The app must work from `design-vault/data/designs` without `http://127.0.0.1:3217`.
- Template cards must prefer real Design Vault previews, demos, and preview assets. Abstract color-block fallbacks are allowed only when no preview exists.
- Chat style-template choices must display card-style previews, not plain text pills only.
- The "all templates" entry should be compact in the chat form and open a modal/library that reuses Design Vault card language.
- Template titles must clamp to stable lines; cards must not overflow horizontally or grow unpredictably.
- Selecting a template in chat must persist a rich `metadata.vaultTemplate` snapshot, including slug, kind, package type, skill path, capabilities path, design path, theme path, references, preview image, and activation prompt.
- Skill packages must inject real `SKILL.md`, `capabilities.json`, and references into the agent context. Prompt contexts must inject `design.md`, `open-slide-theme.md`, tokens, and profiles.
- Never rely on the template name as style context. The agent must receive the actual Design Vault files or be told that they are unavailable.
- Default OpenPPT fallback palette, font, and layout rules must be lower priority than selected Design Vault context.
- If a deck already exists when a template is selected, provide or trigger a re-theme path. Persisting metadata alone does not restyle old source.

## Agent Flow

- New projects should not pretend a deck is generated by opening the TSX workbench as the primary result before content generation. The deck workbench becomes the primary surface after the first deck source exists or the user explicitly opens it.
- The chat should choose visual templates after understanding the brief, unless the user explicitly selects one earlier.
- If a design system has already been selected, do not ask generic visual-tone questions that override it.
- If the catalog is unavailable, say so and provide a recovery path; do not proceed while claiming a Vault-backed style.
- Prompt text alone is not a media-generation contract. If generated imagery is required, expose an explicit media/image capability, save produced assets, reference them from `assets/`, and verify they render in preview.
- Imported Design Vault skills and systems must be attachable from the composer. Selected items must appear above the input and be sent as structured context, not as decorative labels.
- Deck generation must not collapse "file written" into "presentation-ready". The agent must distinguish `Generated`, `Renderable`, `Assets verified`, and `Presentation-ready`.
- A deck may be called `Presentation-ready` only after a Deck Director Plan, Presentation Design Contract, Motion Choreography Map, motion coverage gate, per-slide quality review, cross-deck consistency review, render check, and asset check have all passed.
- The final agent message must include a compact gate report or explicitly label the deck `needs polish` with the remaining narrative/design/render gaps. Do not say "complete", "ready for preview", or "ready for your review" based only on page count, asset existence, or successful TSX writes.
- The Deck Director Plan must pin the thesis, audience, proof strategy, page-by-page narrative role, and balance of image-led, data-led, process-led, and conclusion pages before generation.
- The Presentation Design Contract must translate Vault or fallback style into enforceable rules for palette ratio, typography roles, page archetypes, image treatment, components/chrome, motion stance, and dark/light page transitions.
- The Motion Choreography Map must list every page number and the intended motion role for title, primary visual, content group, and page transition. It is reviewed before code generation and rechecked after source edits.

## Export Contract

- Export commands must use the same current deck source and selected slide state as the preview.
- PPTX export must not fall back to stale placeholder decks or default styles when a real Web-PPT deck exists.
- HTML/PDF/PPTX export changes require a simulated download/export smoke test and a visual/content comparison against the current preview.
- If fidelity is not good enough, label the export as experimental or block it from the happy path.

## UI Language And Visual Fit

- Open Slide integration UI must follow the active settings language. New labels, buttons, empty states, and inspector panels must use the same i18n path as the rest of OpenPPT.
- Use icons where the action is icon-standard. Prefer the existing icon library and lucide equivalents over hand-rolled SVGs.
- Avoid giant cards in chat forms when browsing efficiency matters. Recommended templates should be compact but still show a real preview.
- Card frames, image ratios, swatches, titles, and metadata rows must have stable dimensions. No title or image should overflow its card.
- Hover affordances must not create floating panels that cover important canvas regions unless the user explicitly opens them.
- Every responsive layout touched by a change needs desktop and narrow-width visual checks for clipping, overlap, blank canvas, and unusable controls.

## Required Verification

- Run `pnpm guard` and `pnpm typecheck` before marking regular work complete.
- For web or workbench UI changes, restart or refresh the active `tools-dev` app and verify in browser.
- For Open Slide player or deck motion changes, run an automated browser acceptance that enters Present mode, advances pages, and asserts the page-level transition state/animation.
- For slide-source behavior, verify `/api/projects/:id/open-slide/module?slideId=<id>` returns no diagnostics.
- For feedback changes, verify queueing feedback does not alter `slides/<slideId>/index.tsx`.
- For Design Vault changes, verify embedded catalog cards render without external service availability and without `fetch failed`.
- For export changes, generate at least one export artifact and compare it against the visible preview.
- For localization changes, switch settings language and verify the new Open Slide UI strings follow it.

## Stop Conditions

- Do not continue building on a deck with module diagnostics unless the current task is to repair those diagnostics.
- Do not ship a flow that asks the user to reconnect Design Vault for templates already embedded in OpenPPT.
- Do not mark a visual feature complete while the user's reported screen still shows overflow, stale fallback UI, or source corruption symptoms.
- Do not treat local runtime cleanup as a product fix unless the code path that created the bad state is also corrected.
