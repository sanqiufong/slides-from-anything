export const OPENPPT_DECK_CONTRACT = `# Slides from Anything Deck Contract

This project is a Slides from Anything (SFA) Web-PPT deck. The canonical editable source is Open Slide TSX, not an HTML deck artifact.

Hard rules:
- Edit \`slides/<slideId>/index.tsx\` as the primary deliverable. Do not create a standalone \`index.html\` deck unless the user explicitly asks for an export-only fallback.
- The slide module must export \`design: DesignSystem\`, \`meta: SlideMeta\`, and a default \`Page[]\`.
- Each page is authored as a React component for a fixed 1920x1080 canvas.
- Use Open Slide CSS variables from \`design\`: \`--osd-bg\`, \`--osd-text\`, \`--osd-accent\`, \`--osd-font-display\`, \`--osd-font-body\`, \`--osd-size-hero\`, \`--osd-size-body\`, \`--osd-radius\`.
- Keep assets under \`slides/<slideId>/assets/\` and import them from the slide module.
- If \`deckMedia\` is enabled or required, generated imagery is part of the deliverable: call the media dispatcher with the configured image model when one is present, save real files under \`slides/<slideId>/assets/\`, import/render them with \`<img>\` or \`backgroundImage\`, and do not leave \`ImagePlaceholder\`, "Media-model image", or "insert generated image" notes in presentation-ready source. Media prompts must inherit the same selected design system through source anchors, page archetype, media treatment, chrome/caption relationship, line/border language, and density; color matching alone is not enough. When \`deckMedia.required\` is true, at least one generated asset must be visibly embedded before the deck is presentation-ready. If no image model is configured or every configured provider fails, you may continue authoring with an explicit pending media slot, but the deck must be labeled \`needs media replacement\` and must not be called complete or export-ready.
- Preserve existing pages, comments, and design tokens unless the user asks to replace them.
- If attached slide feedback is provided, apply it directly to the matching source lines or semantic target and keep unrelated JSX unchanged.
- If a Vault template is present, treat its \`open-slide-theme.md\`, Design Vault agent context, STYLE_CARD, anti-patterns, and quality gates as the authoritative visual source. Before adding or revising content, reconcile \`export const design\` and page composition with the Vault palette, typography, layout grammar, line language, image treatment, component language, and motion language.
- For key-page images and abstract diagrams, adapt the active Vault media grammar instead of defaulting to generic AI/cyber/process illustration tropes. If the source looks like a case-study portfolio, type specimen, editorial spread, product UI, or data system, the generated image should carry that structure before it carries the slide topic.
- For every generated or selected image, plan the slide container before the image is generated. Decide the image's narrative job, exact 1920x1080 canvas region, CSS dimensions, aspect ratio, fit/crop policy, safe focal area, and relationship to nearby title/body/chrome. Generate an image for that slot; do not generate a generic picture first and then search for a place where it might fit.
- Information-bearing images are not decorative photos. Diagrams, UI screenshots, annotated layouts, process flows, or images containing readable text must be generated as complete self-contained panels with all meaningful content inside the bitmap safe area, then embedded with \`object-fit: contain\` or an equivalent no-crop layout. Use \`object-fit: cover\` only for decorative photography/texture where losing edge detail is acceptable.
- Do not leave generic SFA fallback tokens such as \`#0f172a\`, \`#38bdf8\`, \`Inter\`, or generic \`system-ui\` stacks when a selected Vault template specifies different colors or typefaces.
- Motion is Vault-first: if the selected Vault context says no entrance animation, instant state changes, fade-only, or source-observed motion only, follow that over the generic Open Slide motion helpers.
- Use lightweight motion helpers only when they match the active Vault/skill motion language; otherwise keep final-state static composition plus \`data-osd-freeze-motion\` support and source-derived state transitions.
- Create a **Motion Choreography Map** before writing pages. It must list every page number and the exact motion role for title, primary visual, content group, and page transition. A page may be labeled \`static-final-state\` only when the active Vault/design evidence forbids visible motion.
- Motion coverage is a readiness gate, not decoration. When motion is allowed or requested, at least 60% of pages must expose applied motion via \`data-osd-motion-id\`, \`motionAttrs(...)\`, or Open Slide helper classes such as \`os-motion\`, \`os-fade-up\`, \`os-line-grow\`, \`os-canvas-swap\`, or \`os-motion-stagger\`. Do not satisfy this by defining unused helpers.
- Thumbnails and still previews must freeze motion cleanly through \`data-osd-freeze-motion\` rules that render the final state, not hidden pre-animation elements.
- Do not add heavy animation libraries for normal deck motion. Do not add decorative fade/stagger/slide entrances when the selected design system forbids or lacks evidence for them.

## Vault Token Contract
When a Vault template is active, the deck \`<head>\` is prepended with a \`<style>\` block exposing the template's tokens as CSS custom properties. You MUST reference these instead of hardcoding values:
- Colors: \`var(--dv-bg)\`, \`var(--dv-bg-alt)\`, \`var(--dv-bg-deep)\`, \`var(--dv-text-primary)\`, \`var(--dv-text-muted)\`, \`var(--dv-accent)\`, plus canonical layout-role aliases \`var(--dv-color-role-hero)\`, \`var(--dv-color-role-persistent-chrome)\`, \`var(--dv-color-role-alt-section)\`, \`var(--dv-color-role-deep-section)\`. Use \`role-hero\` for cover slides, \`role-deep-section\` for closing/CTA slides, \`role-persistent-chrome\` for chrome bars.
- Motion: \`var(--dv-motion-tap)\`, \`var(--dv-motion-reveal)\`, \`var(--dv-motion-emphasized)\`, paired with \`var(--dv-ease-standard)\` / \`var(--dv-ease-emphasized)\`. These reflect the SOURCE site's actual observed tempo — DO NOT substitute generic 150/220/320ms defaults.
- Radius: \`var(--dv-radius-button)\`, \`var(--dv-radius-card)\`, \`var(--dv-radius-modal)\`, \`var(--dv-radius-avatar)\`. If the primitive scale collapses to 0px (editorial-flat sources like noa), every corner you draw MUST be square. Do not bypass with hardcoded \`border-radius: 8px\`.
- Posture: read \`tokens.semantic.posture\` from profile.json. Values map to choreography presets — \`restrained\`: no entrance animation beyond opacity, \`expressive\`: modest hover lifts + fade-up entries, \`dramatic\`: long emphasized eases + scroll-pinned reveals, \`playful\`: spring/bounce. Apply the active posture consistently across every page of the deck.
- When \`tokens.semantic.bg.alt\` is \`null\`, the source has NO true alt surface — do not invent an interlude band color.
Hardcoded hex, ms, or px values that already have a \`--dv-*\` token equivalent are a Vault-fidelity violation and will fail review.

## Vault Source Fidelity Contract
When a Vault template is active, style fidelity is a visible gate, not a token-only gate:
- Preserve 3-5 source-recognition anchors from the Vault context before choosing generic deck layouts. Anchors include source visuals, dominant title hierarchy, image/media treatment, chrome controls, component states, spacing density, and accent budget.
- If the Vault context lists localized source visual assets, inspect them and copy at least one representative source asset into \`slides/<slideId>/assets/\` for the source-recognition cover or another major visual page. Media-led templates are not presentation-ready as all-text decks.
- The cover must be a source-recognition cover: it should feel traceable to STYLE_CARD / preview imagery before the user reads any words. Do not open with a generic centered title over a black or white field unless that exact relationship is source evidence.
- Before final status, run a source-fidelity audit against STYLE_CARD, \`open-slide-theme.md\`, anti-patterns, and quality gates. If the output could be mistaken for a generic consulting, SaaS, or black-and-white metrics deck, revise it before calling it renderable or presentation-ready.

Presentation readiness workflow:
- Before writing or rewriting slide code, create a Deck Director Plan. It must name the deck's one-sentence thesis, target audience, proof strategy, page-by-page narrative role, and the intended balance of image-led, data-led, process-led, and conclusion slides.
- Convert the active Vault template, design system, or fallback visual choice into a Presentation Design Contract before generating pages. The contract must pin palette usage, typography roles, page archetypes, image treatment, component language, motion stance, and explicit rules for mixing dark/light or image/text pages.
- Create a **Media Slot Plan** before calling any image model. For each planned image, list page number, output filename, what information the image must show, why an image is needed, the slide container coordinates or CSS size, final aspect ratio, object-fit/object-position, crop-safe zones, and how the surrounding text/chrome will align to it. If the right slot would be an unsupported media aspect, adjust the page layout to a supported aspect before generation instead of stretching or awkwardly cropping afterward.
- Generate against the plan, not page-by-page in isolation. Every slide must have a single takeaway, a role in the deck arc, and enough useful information density for its page type. Empty space is allowed only when it supports hierarchy, contrast, or pacing.
- Run a Slide Quality Critic pass after code edits. Check each page for narrative usefulness, business specificity, visual hierarchy, text fit, planned media-slot fit, asset fit, and whether the slide proves something the deck needs.
- Run a Media Crop Gate after embedding generated images. If any important label, icon, arrow, diagram node, UI panel, person, or text is clipped by the image edge or by CSS object fitting, regenerate the asset with stronger safe margins or switch the slide slot to a no-crop contain layout before calling the deck presentation-ready.
- Run a Cross-deck Review pass before the final response. Check visual continuity, repeated components, rhythm between image and information pages, terminology consistency, and whether adjacent slides actually advance the argument.
- Run a Motion Coverage Gate before the final response. Check that the Motion Choreography Map exists, applied motion coverage reaches the 60% threshold when motion is expected, freeze/reduced-motion fallbacks exist, and unused helper definitions are not being counted as complete motion.
- If any gate fails, keep revising the source before calling the work done. Do not stop at "file exists", "8 pages generated", "images saved", or "preview renders".
- Status language is strict: "Generated" means files were written; "Renderable" means the Open Slide module compiles and previews; "Assets verified" means referenced assets exist and render; "Presentation-ready" means the narrative, design, motion coverage, per-slide, cross-deck, render, and asset gates all pass. Never say "complete", "ready for preview", or "ready for your review" based only on page count or asset existence.
- In the final assistant message, include a compact gate report. If anything is below the bar, label the deck "needs polish" and name the exact remaining work instead of claiming completion.

Recommended module shape:

\`\`\`tsx
import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';

export const design: DesignSystem = {
  palette: { bg: '#ffffff', text: '#111111', accent: '#2563eb' },
  fonts: { display: '...', body: '...' },
  typeScale: { hero: 148, body: 34 },
  radius: 16,
};

const motionStyles = \`/* source-compatible motion helpers and data-osd-freeze-motion rules */\`;
const MotionStyles = () => <style>{motionStyles}</style>;
const motionChoreography = [
  { page: 1, title: 'fade-up', primary: 'line-grow', content: 'stagger', transition: 'canvas-swap' },
];

const Cover: Page = () => (
  <div style={{ width: '100%', height: '100%' }}>
    <MotionStyles />
    ...
  </div>
);

export const meta: SlideMeta = { title: 'Deck title' };
export default [Cover] satisfies Page[];
\`\`\`

Delivery priority:
1. Editable Web-PPT preview/editing inside Slides from Anything.
2. HTML/PDF export using Open Slide export paths.
3. PPTX is an optional derived export, not the source of truth.`;
