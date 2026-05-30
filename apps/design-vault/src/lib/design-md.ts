import type { BehaviorSignal, ComponentMotionRecipe, DesignEvidence, DesignSystemProfile, ExtractedSection, ResponsiveSignal, VisualCrossCheck } from "./types";

function bullet(items: Array<string | undefined>) {
  const normalized = items.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return normalized.length > 0 ? normalized.map((item) => `- ${item}`).join("\n") : "- No evidence captured.";
}

function tableRows(rows: string[][]) {
  if (rows.length === 0) return "";
  const [head, ...body] = rows;
  const separator = head.map(() => "---");
  return [head, separator, ...body]
    .map((row) => `| ${row.map((cell) => String(cell ?? "").replace(/\|/g, "/").replace(/\n/g, " ")).join(" | ")} |`)
    .join("\n");
}

function summarizeList(items: string[] | undefined, fallback = "No evidence") {
  const normalized = (items ?? []).map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return normalized.length > 0 ? normalized.join("; ") : fallback;
}

function sourceEvidenceLedger(evidence?: DesignEvidence) {
  if (!evidence) {
    return `### Source Evidence Ledger

- No structured evidence object was available for this entry. Regenerate it through the ingestion pipeline before production reuse.`;
  }

  return `### Source Evidence Ledger

The visual media packet is the primary source of truth for experiential sites. DOM/CSS evidence is auxiliary: it names what the screenshots/video already show, but it must not flatten motion, perspective, crop, or image choreography into generic tokens.

${tableRows([
  ["Evidence type", "Captured signal", "How downstream systems should use it"],
  ["DOM topology", `${evidence.domSignals.sectionCount} sections/articles/main nodes, ${evidence.domSignals.navCount} nav/header nodes`, "Preserve macro page order before styling components."],
  ["Actions", `${evidence.domSignals.buttonCount} buttons, ${evidence.buttonLabels.length} label samples`, "Derive CTA hierarchy from real action labels, not generic button variants."],
  ["Assets", `${evidence.assetSummary.total} saved assets (${evidence.assetSummary.images} images, ${evidence.assetSummary.svgs} SVGs, ${evidence.assetSummary.videos} videos)`, "Prefer real logos/icons/images/motion captures when they carry recognition."],
  ["Color candidates", `${evidence.colorCandidates.length} top values`, "Treat frequency as evidence only; assign roles through contrast and context."],
  ["Rendered journey", `${evidence.visualCrossCheck?.steps.length ?? 0} viewport/state captures`, "Use scroll and hover captures to correct static first-frame or CSS-only conclusions."],
  ["Media packet", `${evidence.visualCrossCheck?.mediaArtifacts?.filter((item) => item.kind === "image").length ?? 0} keyframes, ${evidence.visualCrossCheck?.mediaArtifacts?.filter((item) => item.kind === "video").length ?? 0} videos`, "For motion-heavy sites, inspect media before accepting typography/color/layout conclusions."],
  ["Typography candidates", `${evidence.fontCandidates.length} families`, "Use candidates to infer display/body/mono roles, then document confidence."],
  ["Behavior", `${evidence.behaviorSignals?.length ?? 0} behavior signals`, "States and motion must be component requirements, not afterthoughts."],
  ["Responsive CSS", `${evidence.responsiveSignals?.length ?? 0} media-query hints`, "Breakpoints should preserve content priority and source density."],
])}

${evidence.sourceChain?.length ? `#### Source chain

${tableRows([
  ["Role", "Host", "URL", "Note"],
  ...evidence.sourceChain.map((entry) => [entry.role, entry.host, entry.url, entry.note]),
])}` : ""}

${bullet(evidence.notes)}`;
}

function roleEvidenceTable(evidence?: DesignEvidence) {
  const rows = evidence?.roleEvidence?.map((item) => [
    item.role,
    item.value,
    item.confidence,
    summarizeList(item.evidence, "No source note"),
  ]);
  if (!rows?.length) {
    return "- No role-level evidence captured. Re-run ingestion to attach color and typography role evidence.";
  }
  return tableRows([["Role", "Value", "Confidence", "Evidence"], ...rows]);
}

function renderedMediaTable(visualCrossCheck?: VisualCrossCheck) {
  const rows = (visualCrossCheck?.mediaArtifacts ?? []).slice(0, 10).map((artifact) => [
    artifact.kind,
    artifact.role,
    artifact.path,
    artifact.stepId ?? "-",
    artifact.modelEligible ? "yes" : "downstream only",
    artifact.description,
  ]);
  if (!rows.length) return "- No media packet captured. Re-run URL ingestion with browser media capture before trusting motion-heavy abstractions.";
  return tableRows([["Kind", "Role", "Path", "Step", "Sent to model", "Use"], ...rows]);
}

function renderedJourneyTable(visualCrossCheck?: VisualCrossCheck) {
  if (!visualCrossCheck?.steps.length) {
    return "- No rendered visual journey captured. Re-run URL ingestion with browser capture available before trusting below-fold visual conclusions.";
  }
  const rows = visualCrossCheck.steps.slice(0, 8).map((step) => [
    step.id,
    step.action,
    `${Math.round(step.scrollRatio * 100)}%`,
    step.screenshotPath ?? "not saved",
    summarizeList(step.sectionLabels.slice(0, 2), "No visible section label"),
    summarizeList(step.colorCandidates.slice(0, 4).map((color) => `${color.value} ${Math.round(color.coverage * 100)}% ${color.source}`), "No color sample"),
  ]);
  const warnings = visualCrossCheck.warnings.length ? `\n\nWarnings:\n${bullet(visualCrossCheck.warnings.slice(0, 4))}` : "";
  return `${tableRows([["Step", "Action", "Scroll", "Screenshot", "Visible section", "Rendered colors"], ...rows])}

#### Media packet

${renderedMediaTable(visualCrossCheck)}${warnings}`;
}

function renderedDominantColorTable(visualCrossCheck?: VisualCrossCheck) {
  const rows = (visualCrossCheck?.dominantColors ?? []).slice(0, 8).map((color) => [
    color.value,
    `${Math.round(color.coverage * 100)}%`,
    String(color.seenInSteps),
    color.roleHint ?? "unclassified",
  ]);
  if (!rows.length) return "- No rendered dominant color summary captured.";
  return tableRows([["Color", "Max viewport coverage", "Seen in steps", "Role hint"], ...rows]);
}

function sectionTopologyTable(sections?: ExtractedSection[]) {
  const rows = (sections ?? []).slice(0, 12).map((section) => [
    String(section.order),
    section.role,
    section.label || section.selector,
    section.selector,
    summarizeList(section.headings, "No heading"),
    summarizeList(section.componentHints, "No component hint"),
    summarizeList(section.interactionHints, "Display-only or unknown"),
  ]);
  if (!rows.length) return "- No section topology captured. Do not trust layout generation until source sections are sampled.";
  return tableRows([["Order", "Role", "Label", "Selector", "Heading evidence", "Component hints", "Interaction hints"], ...rows]);
}

function behaviorTable(signals?: BehaviorSignal[]) {
  const rows = (signals ?? []).slice(0, 16).map((signal) => [
    signal.kind,
    signal.selector,
    signal.source,
    signal.confidence,
    signal.evidence,
  ]);
  if (!rows.length) return "- No structured behavior signals captured. Default to restrained interactions and verify with browser screenshots before shipping.";
  return tableRows([["Kind", "Selector", "Source", "Confidence", "Evidence"], ...rows]);
}

function motionRecipeTable(recipes?: ComponentMotionRecipe[]) {
  const rows = (recipes ?? []).slice(0, 8).map((recipe) => [
    recipe.component,
    recipe.trigger,
    recipe.statePair,
    summarizeList(recipe.properties, "No property"),
    `${recipe.timing.duration} / ${recipe.timing.easing}${recipe.timing.stagger ? ` / stagger ${recipe.timing.stagger}` : ""}`,
    summarizeList(recipe.choreography, "No choreography"),
    summarizeList(recipe.pptAdapter, "No PPT adapter"),
    `${recipe.confidence}: ${summarizeList(recipe.evidence, "No evidence")}`,
  ]);
  if (!rows.length) return "- No component motion recipes captured. Use interactionModel.motionNotes only and keep preview motion minimal.";
  return tableRows([["Component", "Trigger", "State pair", "Properties", "Timing", "Choreography", "PPT adapter", "Evidence"], ...rows]);
}

function motionChoreographySection(mc?: DesignSystemProfile["motionChoreography"]) {
  if (!mc) return "";
  const entrance = (mc.entrance ?? []).map(
    (s) => `- ${s.target}: ${s.motion} · ${s.duration} · delay ${s.delay} · ${s.easing}`,
  );
  const page = mc.pageTransition
    ? `- Page turn: ${mc.pageTransition.motion} · ${mc.pageTransition.duration} · ${mc.pageTransition.easing}${mc.pageTransition.stagger ? ` · stagger ${mc.pageTransition.stagger}` : ""}`
    : "";
  const body = [
    mc.posture ? `- Posture: ${mc.posture}` : "",
    ...entrance,
    page,
    ...bullet(mc.choreographyNotes ?? []).split("\n").filter(Boolean),
  ].filter(Boolean).join("\n");
  return `\n### Motion choreography (v1)\n\n${body || "- No deterministic choreography derived."}\n\n_Provenance: ${mc.provenance.method}, confidence ${mc.provenance.confidence}, sources: ${mc.provenance.sources.join(", ")}_\n`;
}

function responsiveTable(signals?: ResponsiveSignal[]) {
  const rows = (signals ?? []).slice(0, 10).map((signal) => [signal.breakpoint, signal.evidence, summarizeList(signal.affectedSelectors, "selector extraction pending")]);
  if (!rows.length) return "- No media-query evidence captured. Use conservative mobile-first stacking and verify manually.";
  return tableRows([["Breakpoint / condition", "Evidence", "Affected selectors"], ...rows]);
}

function componentEvidenceRules(evidence?: DesignEvidence) {
  const sections = evidence?.sections ?? [];
  const relevant = sections
    .filter((section) => section.componentHints.length > 0 || section.ctas.length > 0 || section.interactionHints.length > 0)
    .slice(0, 8)
    .map(
      (section) =>
        `- ${section.label || section.selector}: ${summarizeList(section.componentHints, "section surface")} / states: ${summarizeList(section.interactionHints, "default only")}`,
    );
  return relevant.length > 0 ? relevant.join("\n") : "- No component-level evidence captured.";
}

function stateInventory(evidence?: DesignEvidence) {
  return bullet(evidence?.stateInventory?.length ? evidence.stateInventory : ["default", "hover", "active", "focus-visible", "disabled"]);
}

function cssVars(profile: DesignSystemProfile) {
  const altLine = profile.colorRoles.surfaceAlternate
    ? `  --surface-alt: ${profile.colorRoles.surfaceAlternate};\n`
    : "";
  const deepLine = profile.colorRoles.surfaceDeep
    ? `  --surface-deep: ${profile.colorRoles.surfaceDeep};\n`
    : "";
  return `\`\`\`css
:root {
  --bg: ${profile.colorRoles.background};
  --surface: ${profile.colorRoles.background};
${altLine}${deepLine}  --fg: ${profile.colorRoles.text};
  --muted: ${profile.colorRoles.brandSecondary};
  --accent: ${profile.colorRoles.brandPrimary};
  --border: color-mix(in srgb, var(--fg) 14%, transparent);
  --font-display: ${profile.typographyRoles.display};
  --font-body: ${profile.typographyRoles.body};
  --font-mono: ${profile.typographyRoles.mono};
}
\`\`\``;
}

function qualityGateTable(profile: DesignSystemProfile) {
  const quality = profile.quality;
  if (!quality) {
    return "- No quality gate report captured. Regenerate this record before production reuse.";
  }

  const rows = quality.gates.map((gate) => [
    gate.label,
    `${gate.score}/${gate.maxScore}`,
    gate.status,
    summarizeList(gate.evidence.slice(0, 3), "No evidence"),
    gate.recommendation,
  ]);

  return `- Score: ${quality.score}/100
- Threshold: ${quality.threshold}/100
- Grade: ${quality.grade}
- Summary: ${quality.summary}

${tableRows([["Gate", "Score", "Status", "Evidence", "Production action"], ...rows])}`;
}

function componentSection(items: DesignSystemProfile["componentSignatures"]) {
  return items
    .map(
      (item) => `### ${item.name}

- 角色：${item.role}
- 主要特征：${item.traits.join("；")}
- 状态要求：${item.states.join("；")}`,
    )
    .join("\n\n");
}

function presentationStyleSection(profile: DesignSystemProfile) {
  const style = profile.presentationStyle;
  if (!style) {
    return `### Presentation transfer grammar

- No presentation transfer grammar captured yet. Re-ingest or refresh this record with the AI model layer before generating production slides.`;
  }

  return `### Presentation transfer grammar

This section turns the website design system into an executable deck language. It is inspired by the guizang-ppt-skill pattern: plan the narrative and slide rhythm before choosing components or token values.

#### Narrative arc

${bullet(style.narrativeArc)}

#### Theme rhythm

- Palette rule: ${style.themeRhythm.paletteRule}

Light / dark or density pattern:

${bullet(style.themeRhythm.lightDarkPattern)}

Emphasis cadence:

${bullet(style.themeRhythm.emphasisCadence)}

#### Slide archetypes

${style.slideArchetypes
  .map(
    (item) => `- ${item.name}: ${item.use}
  - Construction: ${item.construction.join(" / ")}`,
  )
  .join("\n")}

#### Typography hierarchy for slides

${bullet(style.typographyHierarchy)}

#### Image and asset art direction

${bullet(style.imageRules)}

#### Deck motion recipes

${bullet(style.motionRecipes)}

#### Chrome and metadata

${bullet(style.chromeAndMetadata)}

#### Presentation quality checks

${bullet(style.qualityChecks)}`;
}

export function buildDesignMd(profile: DesignSystemProfile, sourceHost: string, sourceMode: string, evidence?: DesignEvidence) {
  const sourceNotes = [
    `Schema: v${profile.schemaVersion}`,
    `Source: ${sourceHost} via ${sourceMode}`,
    `Archetype: ${profile.archetype}`,
    `Confidence: ${profile.confidence}`,
    `Synthesis: ${profile.synthesis.mode}${profile.synthesis.model ? ` (${profile.synthesis.model})` : ""}`,
    profile.synthesis.status ? `AI status: ${profile.synthesis.status}` : undefined,
    profile.synthesis.durationMs ? `AI duration: ${profile.synthesis.durationMs}ms` : undefined,
    profile.synthesis.reason ? `AI note: ${profile.synthesis.reason}` : undefined,
  ];

  return `# Design System Inspired by ${profile.systemName}

> Category: ${profile.archetype}
> ${profile.summary}

This file follows the Open Design 9-section DESIGN.md contract: it is a portable design language for downstream generators, not a token dump. Treat the rules below as binding unless a human reviewer updates the evidence.

## 1. Visual Theme & Atmosphere

${profile.visualThesis}

### Source contract

${bullet(sourceNotes)}

### 9/10 production quality gate

${qualityGateTable(profile)}

### Clone-informed extraction method

This system follows the clone-website discipline: extract global style and page topology first, identify behavior and states before building, then write reusable section/component specs. Tokens are evidence; they are not the design system by themselves.

${profile.methodology ? `#### Source of truth

${bullet(profile.methodology.sourceOfTruth)}

#### Abstraction steps

${bullet(profile.methodology.abstractionSteps)}` : "- No methodology profile was captured."}

${sourceEvidenceLedger(evidence)}

### Visual DNA

${profile.visualDna ? bullet([
  `Color atmosphere: ${profile.visualDna.colorAtmosphere}`,
  `Typography signal: ${profile.visualDna.typographySignal}`,
  `Layout grammar: ${profile.visualDna.layoutGrammar}`,
  `Component language: ${profile.visualDna.componentLanguage}`,
  `Motion character: ${profile.visualDna.motionCharacter}`,
]) : "- No visual DNA profile was captured."}

### Must preserve

${profile.visualDna ? bullet(profile.visualDna.mustPreserve) : "- Preserve the source page's dominant background, typography, spacing rhythm, and component affordances."}

### Fidelity gates

${profile.methodology ? bullet(profile.methodology.fidelityChecks) : "- Generated work must preserve the source site's strongest first-screen recognition signals."}

## 2. Color

### Core tokens

${cssVars(profile)}

${tableRows([
  ["Role", "Value", "Usage"],
  ["Background / surface", profile.colorRoles.background, "Default canvas and section field. Do not replace unless source evidence supports the change."],
  ...(profile.colorRoles.surfaceAlternate
    ? [["Surface — alternate", profile.colorRoles.surfaceAlternate, "Second large surface used to interrupt the background rhythm (pull-quote sections, light/dark breaks). Equivalent layout role to `background`, different color identity."] as [string, string, string]]
    : []),
  ...(profile.colorRoles.surfaceDeep
    ? [["Surface — deep", profile.colorRoles.surfaceDeep, "Closing / heaviest surface used for footer + CTA caps. Higher contrast than `background`; not the same as `text`."] as [string, string, string]]
    : []),
  ["Foreground", profile.colorRoles.text, "Primary heading and body color."],
  ["Accent", profile.colorRoles.brandPrimary, "Primary brand/action color. Use sparingly and with intent."],
  ["Muted / secondary", profile.colorRoles.brandSecondary, "Secondary text, rules, quiet metadata, or supporting mark."],
])}

### Color rules

${bullet(profile.colorRoles.notes)}

### Role evidence

${roleEvidenceTable(evidence)}

### Rendered journey color check

${renderedDominantColorTable(evidence?.visualCrossCheck)}

- Preserve the source-observed pixel balance between background, text, accent, image, and support colors.
- Do not invent semantic colors unless the source evidence clearly shows success, warning, or danger states.
- Body text must meet 4.5:1 contrast; large text and UI boundaries must meet 3:1.

## 3. Typography

### Font roles

${tableRows([
  ["Role", "Family", "How to use"],
  ["Display", profile.typographyRoles.display, "Hero titles, major section titles, and high-recognition brand moments."],
  ["Body", profile.typographyRoles.body, "Paragraphs, navigation, lists, and primary interface copy."],
  ["Mono", profile.typographyRoles.mono, "Code, data, metadata, technical labels, or source-specific mono cues."],
])}

### Type behavior

${bullet(profile.typographyRoles.rationale)}

- Keep type scale, tracking, case behavior, and line length aligned with the source hierarchy or mark the rule as inferred.
- Display text may use tighter leading or tracking only when that matches the source typography signal.
- If source typography evidence is weak, prefer readable defaults and mark the exact scale as review-needed.

## 4. Spacing & Grid

- Base rhythm: ${profile.spacingSystem.base}
- Density: ${profile.spacingSystem.density}

### Rhythm rules

${bullet(profile.spacingSystem.rhythmNotes)}

### Responsive evidence

${responsiveTable(evidence?.responsiveSignals)}

### Grid rules for generators

- Decide the page's macro grid before styling individual cards.
- Align repeated panels to shared columns and row heights when they appear in the same band.
- Use stable dimensions for fixed-format elements so labels, hover states, or dynamic values do not resize the layout.
- On mobile, preserve content priority and remove side-by-side dependencies before reducing text size.

## 5. Layout & Composition

### Page topology

${sectionTopologyTable(evidence?.sections)}

### Rendered scroll / interaction journey

${renderedJourneyTable(evidence?.visualCrossCheck)}

### Composition signatures

${bullet(profile.compositionSignatures)}

${profile.previewStrategy ? `### Preview / artifact strategy

- Renderer: ${profile.previewStrategy.renderer}
- Rationale: ${profile.previewStrategy.rationale}

#### Layout directives

${bullet(profile.previewStrategy.layoutDirectives)}

#### Avoid directives

${bullet(profile.previewStrategy.avoidDirectives)}` : "### Preview / artifact strategy\n\n- Use the visual DNA and component signatures above as the layout source of truth."}

### Slide translation

- Direction: ${profile.openSlideGuidance.direction}
- Cover approach: ${profile.openSlideGuidance.coverApproach}

${bullet(profile.openSlideGuidance.layoutApproach)}

${presentationStyleSection(profile)}

## 6. Components

${componentSection(profile.componentSignatures)}

### Source-derived component inventory

${componentEvidenceRules(evidence)}

### Component construction rules

- Components must inherit the color, type, radius, border, and density language above.
- Never turn a line-based or editorial source into generic rounded cards unless the source actually uses that grammar.
- Every interactive component needs default, hover, active, focus-visible, and disabled states unless it is display-only.
- Interactive components must use the component motion recipes below; do not substitute generic fades when source-derived recipes exist.
- Repeated modules should share internal padding, heading scale, and action placement.

## 7. Motion & Interaction

- Interaction character: ${profile.interactionModel.character}

### Behavior evidence

${behaviorTable(evidence?.behaviorSignals)}

### Required states

${bullet(profile.interactionModel.states)}

### State inventory from source

${stateInventory(evidence)}

### Motion rules

${bullet(profile.interactionModel.motionNotes)}

### Component motion recipes

${motionRecipeTable(profile.componentMotionRecipes)}
${motionChoreographySection(profile.motionChoreography)}
- Use source-observed motion timing when available; otherwise keep transitions minimal and functional.
- Motion should confirm state changes or spatial movement; do not use animation as decoration without source evidence.
- Respect reduced motion for transforms, parallax, scale, and repeated ambient movement.

## 8. Voice & Brand

### Tone

${bullet(profile.voiceAndBrand.tone)}

### Copy rules

${bullet(profile.voiceAndBrand.copyNotes)}

### Evidence summary

${bullet(profile.evidenceSummary)}

## 9. Anti-patterns

${bullet(profile.antiPatterns)}

### Universal craft gates

- No default Tailwind indigo or purple-blue trust gradients unless the source brand explicitly uses them.
- No emoji feature icons; use real iconography or typography.
- No invented metrics, fake social proof, or placeholder copy.
- No decorative blobs, arbitrary bokeh, or generic glass cards unless they are visible source traits.
- No raw hex sprawl outside the token block; downstream artifacts should reference the named roles above.

### Downstream prompt guide

- Start from section 1 and 5 before choosing components: capture atmosphere and composition first.
- Bind the CSS variables in section 2 before writing layout code.
- Build components from section 6, then audit against section 9.
- Before shipping, compare the first viewport against the source recognition signals and run the fidelity gates in section 1.

### Accessibility and risk notes

${bullet(profile.accessibilityAndRisks)}
`;
}

export function buildOpenSlideTheme(profile: DesignSystemProfile) {
  const themeId = profile.systemName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const background = profile.colorRoles.background.toLowerCase();
  const darkMode = background === "#000000" || background === "#080808" || profile.previewStrategy?.renderer === "dark-event" || profile.previewStrategy?.renderer === "immersive-experiment";
  return `---
id: ${themeId}
title: ${profile.systemName}
mode: ${darkMode ? "dark" : "light"}
---

# ${profile.systemName}

## Direction

${profile.openSlideGuidance.direction}

## Palette

- bg: ${profile.colorRoles.background}
- text: ${profile.colorRoles.text}
- accent: ${profile.colorRoles.brandPrimary}
- muted: ${profile.colorRoles.brandSecondary}${profile.colorRoles.surfaceAlternate ? `\n- surface-alt: ${profile.colorRoles.surfaceAlternate}` : ""}${profile.colorRoles.surfaceDeep ? `\n- surface-deep: ${profile.colorRoles.surfaceDeep}` : ""}

## Typography

- display: ${profile.typographyRoles.display}
- body: ${profile.typographyRoles.body}
- mono: ${profile.typographyRoles.mono}

## Layout

${bullet(profile.openSlideGuidance.layoutApproach)}

${profile.presentationStyle ? `## Presentation Transfer Grammar

### Narrative Arc

${bullet(profile.presentationStyle.narrativeArc)}

### Theme Rhythm

- palette rule: ${profile.presentationStyle.themeRhythm.paletteRule}

${bullet([...profile.presentationStyle.themeRhythm.lightDarkPattern, ...profile.presentationStyle.themeRhythm.emphasisCadence])}

### Slide Archetypes

${profile.presentationStyle.slideArchetypes
  .map((item) => `- ${item.name}: ${item.use}; construction: ${item.construction.join(" / ")}`)
  .join("\n")}

### Typography, Images, Chrome

${bullet([
  ...profile.presentationStyle.typographyHierarchy,
  ...profile.presentationStyle.imageRules,
  ...profile.presentationStyle.chromeAndMetadata,
])}

### Motion Transfer

${motionRecipeTable(profile.componentMotionRecipes)}

### Production Checks

${bullet(profile.presentationStyle.qualityChecks)}

` : ""}

${profile.visualDna ? `## Visual DNA

- color atmosphere: ${profile.visualDna.colorAtmosphere}
- typography signal: ${profile.visualDna.typographySignal}
- layout grammar: ${profile.visualDna.layoutGrammar}
- component language: ${profile.visualDna.componentLanguage}

` : ""}${profile.previewStrategy ? `## Preview Strategy

- renderer: ${profile.previewStrategy.renderer}
- rationale: ${profile.previewStrategy.rationale}

` : ""}## Motion Philosophy

${bullet(profile.openSlideGuidance.motionApproach)}

## Anti-patterns

${bullet(profile.antiPatterns.slice(0, 5))}
`;
}
