---
name: openppt-deck
description: Build and revise editable OpenPPT Web-PPT decks with Open Slide TSX as the canonical source.
triggers:
  - ppt
  - pptx
  - web-ppt
  - deck
  - presentation
od:
  mode: deck
  default_for:
    - deck
  design_system:
    requires: false
  preview:
    type: open-slide
  motion:
    required: true
---

# OpenPPT Deck Skill

You are authoring an OpenPPT project. The source of truth is an Open Slide module, not a legacy HTML deck artifact.

## File Contract

- Primary file: `slides/<slideId>/index.tsx`.
- Asset folder: `slides/<slideId>/assets/`.
- Import types from `@open-slide/core`: `DesignSystem`, `Page`, `SlideMeta`.
- Export `design`, `meta`, and `default [Page...] satisfies Page[]`.
- Use a fixed 1920x1080 mental canvas for every page.

## Workflow

1. Read the existing `slides/<slideId>/index.tsx` before editing.
2. Create or update a Deck Director Plan before writing code: thesis, audience, proof strategy, page-by-page narrative role, and slide-type balance.
3. Create or update a Presentation Design Contract before writing code. If a Vault template is present in project metadata, treat its `open-slide-theme.md` guidance, Design Vault agent context, STYLE_CARD, anti-patterns, and quality gates as the authoritative visual style source.
4. Create or update a Motion Choreography Map before writing code. List every page number and the motion role for title, primary visual, content group, and page transition. Use `static-final-state` only when the active source evidence forbids visible motion.
5. Apply queued slide feedback first. Respect `@slide-comment` markers and attached `<attached-slide-feedback>` blocks.
6. Make semantic deck changes directly in JSX components and design token changes in `export const design`.
7. Create or preserve lightweight motion helpers only when they match the active skill or Vault template's motion language. Use CSS animation, no heavy animation runtime. If the Vault template says no entrance animation, instant state changes, fade-only, or source-observed motion only, follow the Vault template.
8. When `deckMedia` is enabled or the user asks for key-page images, write image prompts from the same Vault/source media grammar: crop, density, image treatment, chrome/caption relationship, line language, and component roles. The media model should not receive a generic topic prompt plus colors.
9. Preserve unrelated pages, imports, assets, animation helpers, and existing comments.
10. Do not emit `<artifact>` HTML for deck content. Use files on disk.
11. Before final response, run the readiness gates below and keep revising until they pass or explicitly report the remaining gap as "needs polish".

## Quality Bar

- Text must fit inside the 1920x1080 canvas without overlap.
- Prefer clear visual hierarchy, reusable helper components, and explicit layout dimensions.
- Keep slide designs editable: avoid opaque screenshots for core content.
- Every slide needs one clear takeaway, a narrative role, business-specific substance, and information density appropriate to its page type.
- The deck needs cross-page continuity: palette, typography, chrome, numbering, image treatment, component shapes, and dark/light page transitions must feel intentionally designed, not stitched from separate templates.
- Generated key-page images must feel native to the selected design system. For process diagrams or abstract visuals, translate the source's media/component language instead of falling back to generic AI/cyber/process illustration tropes.
- Motion is source-led. Every page needs either source-compatible restrained motion or an explicitly final-state static composition when the active Vault template forbids or lacks evidence for decorative entrances.
- Motion coverage must be applied in the JSX, not merely defined in a helper string. When motion is allowed or requested, at least 60% of pages need visible applied motion markers such as `data-osd-motion-id`, `motionAttrs(...)`, `os-motion`, `os-fade-up`, `os-line-grow`, `os-canvas-swap`, or `os-motion-stagger`.
- Thumbnails and still previews must freeze motion cleanly by honoring `data-osd-freeze-motion`, rendering the final visual state instead of hidden pre-animation elements.
- If PPTX is requested, treat it as a derived export after the Web-PPT source is correct.

## Readiness Gates

- **Narrative gate**: the deck has a thesis, audience, proof flow, and each page advances the argument.
- **Design gate**: the Presentation Design Contract is visible across the whole deck, including mixed image/text pages.
- **Slide gate**: each page has hierarchy, fit, useful density, and a real takeaway.
- **Motion gate**: the Motion Choreography Map exists, applied motion coverage reaches 60% when motion is expected, thumbnails freeze to final state, reduced-motion behavior exists, and unused helpers are not counted.
- **Asset gate**: generated or referenced assets exist, render, and match the active visual grammar.
- **Render gate**: the Open Slide module compiles without diagnostics and previews in the workbench.
- **Status gate**: use `Generated`, `Renderable`, `Assets verified`, and `Presentation-ready` precisely. Do not say a deck is complete or ready for review just because files, pages, or images exist.
