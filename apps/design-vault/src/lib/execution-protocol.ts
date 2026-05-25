import {
  antiPatternsPath,
  designSpecPath,
  listDesigns,
  productDocPath,
  qualityGatesPath,
  routerRegistryPath,
  routerSkillDir,
  routerSkillPath,
  styleCardPath,
  writeJson,
  writeText,
} from "./storage";
import { normalizeHtmlPreview } from "./html-preview";
import type { DesignMeta, DesignSystemCapability, DesignSystemPackageManifest } from "./types";

type ExecutionProtocolPaths = {
  productPath: string;
  designSpecPath: string;
  styleCardPath: string;
  antiPatternsPath: string;
  qualityGatesPath: string;
  routerSkillPath: string;
};

type AntiPatternRule = {
  id: string;
  severity: "blocker" | "warning";
  rule: string;
  reason: string;
  checkPrompt: string;
};

type QualityGateRule = {
  id: string;
  label: string;
  required: boolean;
  instruction: string;
  evidence: string[];
};

function unique(values: string[]) {
  return [...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
}

function list(items: string[], fallback = "Not captured.") {
  const values = unique(items);
  return values.length ? values.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
}

function capabilitySummary(capabilities: DesignSystemCapability[] | undefined) {
  if (!capabilities?.length) return "- No semantic capabilities were captured for this record.";
  return capabilities
    .slice(0, 18)
    .map((capability) => `- \`${capability.id}\` (${capability.category}): ${capability.usage}`)
    .join("\n");
}

function motionRecipeSummary(meta: DesignMeta) {
  const recipes = meta.profile.componentMotionRecipes ?? [];
  if (!recipes.length) return "- No component motion recipes captured; use only minimal accessible state feedback.";
  return recipes
    .slice(0, 8)
    .map((recipe) => {
      const timing = [recipe.timing.duration, recipe.timing.easing, recipe.timing.stagger ? `stagger ${recipe.timing.stagger}` : undefined].filter(Boolean).join(" / ");
      return `- \`${recipe.id}\` (${recipe.confidence}): ${recipe.component}; ${recipe.trigger}; ${recipe.statePair}; properties ${recipe.properties.join(", ")}; timing ${timing}; PPT: ${recipe.pptAdapter.join(" / ")}`;
    })
    .join("\n");
}

function packageType(meta: DesignMeta) {
  return meta.packageManifest?.packageType ?? (meta.sourceMode === "design-system-project" ? "visual-style-system" : "website-style-system");
}

function bestFor(meta: DesignMeta) {
  return meta.packageManifest?.bestFor?.length
    ? meta.packageManifest.bestFor
    : [
        meta.profile.archetype,
        meta.profile.openSlideGuidance.direction,
        ...meta.profile.compositionSignatures.slice(0, 4),
      ];
}

function notFor(meta: DesignMeta) {
  return meta.packageManifest?.notFor?.length
    ? meta.packageManifest.notFor
    : [
        ...meta.profile.antiPatterns.slice(0, 5),
        ...meta.profile.accessibilityAndRisks.slice(0, 3),
      ];
}

function executionPaths(slug: string): ExecutionProtocolPaths {
  return {
    productPath: productDocPath(slug),
    designSpecPath: designSpecPath(slug),
    styleCardPath: styleCardPath(slug),
    antiPatternsPath: antiPatternsPath(slug),
    qualityGatesPath: qualityGatesPath(slug),
    routerSkillPath: routerSkillPath(),
  };
}

export function executionReferencePrompt(meta: DesignMeta) {
  const paths = executionPaths(meta.slug);
  return `Use Design Vault Router Skill: ${paths.routerSkillPath}. Select the "${meta.title}" design system when it matches the task. Before generating, read ${paths.productPath}, ${paths.designSpecPath}, ${paths.styleCardPath}, ${paths.antiPatternsPath}, and ${paths.qualityGatesPath}. Match STYLE_CARD visual density, typography rhythm, color contrast, and layout grammar. After generating, audit against anti-patterns and quality gates, then revise once before final output.`;
}

export function buildProductMd(meta: DesignMeta) {
  const manifest = meta.packageManifest;
  return `# ${meta.title} PRODUCT

This file tells an agent when this Design Vault system should be used.

## Identity

- Name: ${meta.title}
- Source: ${meta.sourceUrl}
- Source mode: ${meta.sourceMode}
- System role: ${packageType(meta)}
- Confidence: ${manifest?.confidence ?? meta.profile.confidence}
- License: ${manifest?.source.license ?? "unknown"}

## Best For

${list(bestFor(meta))}

## Not For

${list(notFor(meta))}

## Product Context

${meta.summary}

## Voice And Audience

${list([...meta.profile.voiceAndBrand.tone, ...meta.profile.voiceAndBrand.copyNotes])}

## Agent Entry Rule

Use this design system only when the task matches the product context or one of the semantic capabilities. Before building, read:

- PRODUCT.md: product fit and usage boundaries.
- DESIGN.md: executable visual contract.
- STYLE_CARD.html: the visual target; match its density, rhythm, contrast, and component grammar.
- anti-patterns.json: things that must not appear.
- quality-gates.json: final checks before delivery.
`;
}

export function buildDesignSpecMd(meta: DesignMeta) {
  const p = meta.profile;
  const renderedJourneyAssets = meta.assets.filter((asset) => asset.path.includes("visual-journey")).slice(0, 5);
  const renderedJourneyVideos = meta.profile.evidenceSummary
    .filter((item) => /motion-journey\.webm|visual journey video/i.test(item))
    .slice(0, 3);
  return `# ${meta.title} DESIGN

This is the executable design contract for agents. It is shorter and stricter than the evidence document. Use it while building, polishing, and reviewing output.

## Source Of Truth

- Visual target: ${styleCardPath(meta.slug)}
- Original extraction: ${meta.designPath}
- Open-slide theme: ${meta.openSlideThemePath}
- Rendered journey captures: ${renderedJourneyAssets.length ? renderedJourneyAssets.map((asset) => asset.path).join(" / ") : "not captured"}
- Rendered journey video: ${renderedJourneyVideos.length ? renderedJourneyVideos.join(" / ") : "see DESIGN.md media packet when captured"}
- Capabilities: ${meta.capabilitiesPath ?? "not generated"}
- Package manifest: ${meta.manifestPath ?? "website import; no package manifest"}

Media-first rule: for experiential, motion-heavy, image-led, or spatial websites, inspect rendered keyframes and the journey video before using this prose. DOM/CSS/tokens are auxiliary labels; they must not override what the visual media shows.

## Visual Thesis

${p.visualThesis}

## Visual DNA

- Color atmosphere: ${p.visualDna?.colorAtmosphere ?? p.colorRoles.notes.join(" ")}
- Typography signal: ${p.visualDna?.typographySignal ?? p.typographyRoles.rationale.join(" ")}
- Layout grammar: ${p.visualDna?.layoutGrammar ?? p.compositionSignatures.join(" / ")}
- Component language: ${p.visualDna?.componentLanguage ?? p.componentSignatures.map((item) => item.name).join(" / ")}
- Motion character: ${p.visualDna?.motionCharacter ?? p.interactionModel.character}

## Color Roles

- Background: \`${p.colorRoles.background}\`
- Text: \`${p.colorRoles.text}\`
- Primary action / accent: \`${p.colorRoles.brandPrimary}\`
- Secondary / muted: \`${p.colorRoles.brandSecondary}\`

## Typography

- Display: ${p.typographyRoles.display}
- Body: ${p.typographyRoles.body}
- Mono: ${p.typographyRoles.mono}
- Scale: ${meta.tokens.typography.scale.join(" / ")}

## Layout Grammar

${list(p.compositionSignatures)}

## Components And Capabilities

${capabilitySummary(meta.capabilities)}

## Motion And Interaction

- Character: ${p.interactionModel.character}
- States: ${p.interactionModel.states.join(" / ") || "not captured"}
- Motion notes:
${list(p.interactionModel.motionNotes)}

## Component Motion Recipes

${motionRecipeSummary(meta)}

## Build Rule

Do not paste this prose into the UI. Translate it into composition: type scale, spacing, representative scroll-state color fields, component shape, image treatment, camera/crop/perspective, interaction states, and source-derived motion recipes. STYLE_CARD.html is the minimum visual proof for the system.
  `;
}

export function buildAntiPatterns(meta: DesignMeta) {
  const sourceRules = unique([...meta.profile.antiPatterns, ...(meta.profile.previewStrategy?.avoidDirectives ?? [])]);
  const rules: AntiPatternRule[] = [
    ...sourceRules.slice(0, 12).map((rule, index) => ({
      id: `source-${index + 1}`,
      severity: "blocker" as const,
      rule,
      reason: "Captured from the design-system abstraction.",
      checkPrompt: `Inspect the output and confirm it does not violate: ${rule}`,
    })),
    {
      id: "no-style-prose-card",
      severity: "blocker",
      rule: "Do not render design-analysis prose, visual thesis paragraphs, or checklist text as the preview card.",
      reason: "A style card must be a visual artifact, not a report.",
      checkPrompt: "Confirm preview surfaces show composed UI/slide/visual specimens with sparse text only.",
    },
    {
      id: "no-generic-ai-gradient",
      severity: "warning",
      rule: "Avoid generic purple-blue gradients, decorative blobs, and template SaaS hero sections unless explicitly present in the source style.",
      reason: "These are common agent design defaults that erase the imported system's identity.",
      checkPrompt: "Check whether the output is using a generic AI/SaaS visual trope instead of the selected system.",
    },
    {
      id: "no-nested-card-layout",
      severity: "warning",
      rule: "Avoid cards inside cards and floating section-card composition unless the source system documents that structure.",
      reason: "Nested cards flatten the style and make imported systems look like the same dashboard template.",
      checkPrompt: "Review container hierarchy and remove unnecessary framed panels.",
    },
    {
      id: "no-unsafe-framework-mix",
      severity: "blocker",
      rule: "Do not mix this system's global CSS/runtime with Tailwind, shadcn, Bootstrap, or app globals without an explicit adapter choice.",
      reason: "Component systems often rely on global style assumptions.",
      checkPrompt: "Confirm adapters and runtime boundaries before using imported components.",
    },
  ];

  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    source: {
      slug: meta.slug,
      title: meta.title,
      sourceUrl: meta.sourceUrl,
      sourceMode: meta.sourceMode,
      packageType: packageType(meta),
    },
    antiPatterns: rules,
    riskNotes: meta.packageManifest?.riskNotes ?? meta.profile.accessibilityAndRisks,
  };
}

export function buildQualityGates(meta: DesignMeta) {
  const gates: QualityGateRule[] = [
    {
      id: "read-execution-context",
      label: "Read execution context",
      required: true,
      instruction: "Read PRODUCT.md, DESIGN.md, STYLE_CARD.html, anti-patterns.json, and quality-gates.json before generating.",
      evidence: [productDocPath(meta.slug), designSpecPath(meta.slug), styleCardPath(meta.slug)],
    },
    {
      id: "match-style-card",
      label: "Match STYLE_CARD",
      required: true,
      instruction: "The output must match STYLE_CARD visual density, typography rhythm, color contrast, and layout grammar.",
      evidence: [styleCardPath(meta.slug)],
    },
    {
      id: "semantic-capability-match",
      label: "Match semantic capability",
      required: true,
      instruction: "Use capabilities.json or DESIGN.md to choose the right component, layout, workflow, or style mode before building.",
      evidence: meta.capabilitiesPath ? [meta.capabilitiesPath] : [],
    },
    {
      id: "component-motion-transfer",
      label: "Use component motion recipes",
      required: Boolean(meta.profile.componentMotionRecipes?.length),
      instruction: "When component motion recipes exist, translate at least one into the generated preview or deck as source-derived CSS motion, staged emphasis, persistent chrome, or active-state choreography, with reduced-motion handling.",
      evidence: meta.profile.componentMotionRecipes?.map((recipe) => `${recipe.id}: ${recipe.component} / ${recipe.trigger} / ${recipe.confidence}`) ?? [],
    },
    {
      id: "anti-pattern-audit",
      label: "Anti-pattern audit",
      required: true,
      instruction: "After the first draft, inspect output against every blocker in anti-patterns.json and revise once.",
      evidence: [antiPatternsPath(meta.slug)],
    },
    {
      id: "responsive-hardening",
      label: "Responsive hardening",
      required: true,
      instruction: "Check desktop and mobile layout for clipped text, overlap, scroll traps, and broken fixed-ratio preview frames.",
      evidence: meta.profile.quality?.gates.find((gate) => gate.id === "preview-fidelity")?.evidence ?? [],
    },
  ];

  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    source: {
      slug: meta.slug,
      title: meta.title,
      packageType: packageType(meta),
      confidence: meta.packageManifest?.confidence ?? meta.profile.confidence,
    },
    threshold: meta.profile.quality?.threshold ?? 90,
    score: meta.profile.quality?.score,
    sourceQualityGates: meta.profile.quality?.gates ?? [],
    executionGates: gates,
    commands: [
      "/design-vault select-style",
      "/design-vault compose-card",
      "/design-vault build-with-style",
      "/design-vault audit-style",
      "/design-vault polish-output",
      "/design-vault prevent-slop",
    ],
  };
}

export async function writeExecutionProtocol(meta: DesignMeta, styleCardHtml: string) {
  const paths = executionPaths(meta.slug);
  await writeText(paths.productPath, buildProductMd(meta));
  await writeText(paths.designSpecPath, buildDesignSpecMd(meta));
  await writeText(paths.styleCardPath, normalizeHtmlPreview(styleCardHtml, `${meta.title} style card`));
  await writeJson(paths.antiPatternsPath, buildAntiPatterns(meta));
  await writeJson(paths.qualityGatesPath, buildQualityGates(meta));
  return paths;
}

function registryItem(meta: DesignMeta) {
  return {
    slug: meta.slug,
    title: meta.title,
    summary: meta.summary,
    sourceUrl: meta.sourceUrl,
    sourceHost: meta.sourceHost,
    sourceMode: meta.sourceMode,
    packageType: packageType(meta),
    tags: meta.tags ?? [],
    capabilities: meta.capabilities?.map((capability) => ({
      id: capability.id,
      label: capability.label,
      category: capability.category,
      usage: capability.usage,
    })) ?? [],
    bestFor: bestFor(meta),
    notFor: notFor(meta),
    paths: {
      productPath: meta.productPath ?? productDocPath(meta.slug),
      designSpecPath: meta.designSpecPath ?? designSpecPath(meta.slug),
      styleCardPath: meta.styleCardPath ?? styleCardPath(meta.slug),
      antiPatternsPath: meta.antiPatternsPath ?? antiPatternsPath(meta.slug),
      qualityGatesPath: meta.qualityGatesPath ?? qualityGatesPath(meta.slug),
      designPath: meta.designPath,
      openSlideThemePath: meta.openSlideThemePath,
      manifestPath: meta.manifestPath,
      capabilitiesPath: meta.capabilitiesPath,
      skillPath: meta.skillPath,
    },
    referencePrompt: executionReferencePrompt(meta),
  };
}

function routerSkillMarkdown(registryPath: string) {
  return `---
name: design-vault-router
description: Route design tasks to imported Design Vault systems and enforce PRODUCT.md, DESIGN.md, STYLE_CARD.html, anti-pattern, and quality-gate workflow before agents build UI, dashboards, decks, or style previews.
---

# Design Vault Router

Use this skill when an agent needs to choose or apply a design system from Design Vault.

## Commands

- /design-vault select-style: choose the best Design Vault system for the user's task.
- /design-vault compose-card: generate or inspect the fixed-ratio STYLE_CARD.html visual specimen.
- /design-vault build-with-style: build output after reading the selected system's execution context.
- /design-vault audit-style: compare the output against STYLE_CARD.html, anti-patterns.json, and quality-gates.json.
- /design-vault polish-output: revise once for typography rhythm, color roles, layout density, and responsive fit.
- /design-vault prevent-slop: remove generic agent defaults that conflict with the selected system.

## Required Workflow

1. Read the registry: \`${registryPath}\`.
2. Select a system by task surface, package type, tags, capabilities, bestFor/notFor, and source mode.
3. Before generating, read the selected system's:
   - PRODUCT.md
   - DESIGN.md
   - STYLE_CARD.html
   - anti-patterns.json
   - quality-gates.json
4. Build with the selected style. Do not paste design prose into the UI.
5. Audit against anti-pattern blockers and quality gates.
6. Revise once before final output.

## Selection Rules

- Use component-system records for B2B dashboards, data tables, forms, nav, metrics, and admin surfaces.
- Use presentation-system records for decks, editorial slides, launch narratives, horizontal swipe presentations, and visual storytelling.
- Use website-style records when the user asks to match an extracted brand/site style.
- Use agent-skill-package records when the user needs a reusable workflow with its own SKILL.md and references.
- If no system is a strong match, use the execution workflow only: PRODUCT fit, DESIGN constraints, anti-pattern audit, and quality gates.

## Output Rule

Every styled output should be able to answer:

- Which Design Vault system was selected?
- Which files were read?
- Which visual traits from STYLE_CARD were preserved?
- Which anti-patterns were checked?
- Which quality gates passed or needed revision?
`;
}

export async function writeRouterSkill(currentMeta?: DesignMeta) {
  const existing = await listDesigns().catch(() => []);
  const bySlug = new Map(existing.map((design) => [design.slug, design]));
  if (currentMeta) bySlug.set(currentMeta.slug, currentMeta);
  const systems = [...bySlug.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(registryItem);
  const registryPath = routerRegistryPath();
  await writeJson(registryPath, {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    routerSkillPath: routerSkillPath(),
    systems,
  });
  await writeText(routerSkillPath(), routerSkillMarkdown(registryPath));
  return routerSkillDir();
}

export function withExecutionProtocolPaths<T extends DesignMeta>(meta: T): T {
  return {
    ...meta,
    ...executionPaths(meta.slug),
  };
}

export function withManifestExecutionPaths<T extends DesignSystemPackageManifest>(manifest: T): T {
  const paths = executionPaths(manifest.id);
  return {
    ...manifest,
    local: {
      ...manifest.local,
      productPath: paths.productPath,
      designSpecPath: paths.designSpecPath,
      styleCardPath: paths.styleCardPath,
      antiPatternsPath: paths.antiPatternsPath,
      qualityGatesPath: paths.qualityGatesPath,
      routerSkillPath: paths.routerSkillPath,
    },
    skill: {
      ...manifest.skill,
      referencePrompt: `Use Design Vault Router Skill: ${paths.routerSkillPath}. For "${manifest.name}", read ${manifest.skill.entrypoint}, ${paths.productPath}, ${paths.designSpecPath}, ${paths.styleCardPath}, ${paths.antiPatternsPath}, ${paths.qualityGatesPath}, then match capabilities before building and audit once before final output.`,
    },
  };
}
