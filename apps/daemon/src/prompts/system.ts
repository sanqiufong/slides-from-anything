/**
 * Prompt composer. The base is the OD-adapted "expert designer" system
 * prompt (see ./official-system.ts) — a full identity, workflow, and
 * content-philosophy charter. Stacked on top:
 *
 *   1. The discovery + planning + huashu-philosophy layer (./discovery.ts)
 *      — interactive question-form syntax, direction-picker fork,
 *      brand-spec extraction, TodoWrite reinforcement, 5-dim critique,
 *      and the embedded `directions.ts` library.
 *   2. The active design system's DESIGN.md (if any) — palette, typography,
 *      spacing rules treated as authoritative tokens.
 *   3. The active skill's SKILL.md (if any) — workflow specific to the
 *      kind of artifact being built. When the skill ships a seed
 *      (`assets/template.html`, `source/assets/template-swiss.html`) and
 *      references (`references/layouts.md`, `source/references/*.md`), we
 *      inject a hard pre-flight rule above the skill body so the agent reads
 *      them BEFORE writing any code.
 *   4. For decks (skillMode === 'deck' OR metadata.kind === 'deck'), the
 *      deck framework directive (./deck-framework.ts) is pinned LAST so it
 *      overrides any softer slide-handling wording earlier in the stack —
 *      this is the load-bearing nav / counter / scroll JS / print
 *      stylesheet contract that PDF stitching depends on. We also fire on
 *      the metadata path so deck-kind projects without a bound skill
 *      (skill_id null) still get a framework, instead of having the agent
 *      re-author scaling / nav / print logic from scratch each turn. When
 *      the active skill ships its own seed (skill body references
 *      `assets/template.html`), we defer to that seed and skip the generic
 *      skeleton — the skill's framework wins to avoid double-injection.
 *
 * The composed string is what the daemon sees as `systemPrompt` and what
 * the Anthropic path sends as `system`.
 */
import { OFFICIAL_DESIGNER_PROMPT } from './official-system.js';
import { DISCOVERY_AND_PHILOSOPHY } from './discovery.js';
import { DECK_FRAMEWORK_DIRECTIVE } from './deck-framework.js';
import { MEDIA_GENERATION_CONTRACT, OPENPPT_DECK_MEDIA_CONTRACT } from './media-contract.js';
import { OPENPPT_DECK_CONTRACT } from './openppt-deck-contract.js';

type ProjectMetadata = {
  kind?: string;
  intent?: string | null;
  fidelity?: string | null;
  speakerNotes?: boolean | null;
  animations?: boolean | null;
  templateId?: string | null;
  templateLabel?: string | null;
  inspirationDesignSystemIds?: string[];
  imageModel?: string | null;
  imageAspect?: string | null;
  imageStyle?: string | null;
  videoModel?: string | null;
  videoLength?: number | null;
  videoAspect?: string | null;
  audioKind?: string | null;
  audioModel?: string | null;
  audioDuration?: number | null;
  voice?: string | null;
  deckMedia?: {
    enabled?: boolean | null;
    required?: boolean | null;
    imageModel?: string | null;
    imageAspect?: string | null;
    keySlidePolicy?: string | null;
    source?: string | null;
    capturedFrom?: string | null;
  } | null;
  vaultTemplate?: {
    slug?: string | null;
    title?: string | null;
    kind?: 'skill-package' | 'prompt-context' | string | null;
    packageType?: string | null;
    sourceUrl?: string | null;
    sourceHost?: string | null;
    summary?: string | null;
    tags?: string[] | null;
    previewImage?: string | null;
    manifestPath?: string | null;
    capabilitiesPath?: string | null;
    skillPath?: string | null;
    archetype?: string | null;
    confidence?: string | null;
    visualThesis?: string | null;
    toneTags?: string[] | null;
    useCaseTags?: string[] | null;
    audienceFit?: string[] | null;
    contentDensity?: string | { level?: string | null; rationale?: string | null } | null;
    narrativeFit?: string[] | null;
    avoidWhen?: string[] | null;
    matchingRationale?: string[] | null;
    slidePatterns?: string[] | null;
    typographyPersonality?: string | null;
    layoutIntensity?: string | null;
    assetNeeds?: string[] | null;
    mediaPromptGrammar?: string | string[] | null;
    localizationFit?: string | null;
    colorRoles?: {
      brandPrimary?: string | null;
      brandSecondary?: string | null;
      background?: string | null;
      text?: string | null;
      surfaceAlternate?: string | null;
      surfaceDeep?: string | null;
      accentPalette?: Array<{
        hex?: string | null;
        role?: string | null;
        canonicalRole?: string | null;
        coverage?: string | null;
        evidence?: string | null;
      }> | null;
    } | null;
    typographyRoles?: {
      display?: string | null;
      body?: string | null;
      primary?: string | null;
      mono?: string | null;
    } | null;
    openSlideGuidance?: {
      direction?: string | null;
      coverApproach?: string | null;
      layoutApproach?: string[] | null;
      motionApproach?: string[] | null;
    } | null;
    componentMotionRecipes?: Array<{
      id?: string | null;
      component?: string | null;
      role?: string | null;
      trigger?: string | null;
      statePair?: string | null;
      properties?: string[] | null;
      timing?: {
        duration?: string | null;
        easing?: string | null;
        delay?: string | null;
        stagger?: string | null;
      } | null;
      choreography?: string[] | null;
      cssHint?: string | null;
      pptAdapter?: string[] | null;
      evidence?: string[] | null;
      confidence?: string | null;
    }> | null;
    designPath?: string | null;
    openSlideThemePath?: string | null;
    tokensPath?: string | null;
    evidencePath?: string | null;
    profilePath?: string | null;
    references?: string[] | null;
    activationPrompt?: string | null;
  } | null;
  promptTemplate?: {
    id?: string | null;
    surface?: 'image' | 'video' | null;
    title?: string | null;
    prompt?: string | null;
    summary?: string | null;
    category?: string | null;
    tags?: string[] | null;
    model?: string | null;
    aspect?: string | null;
    source?: {
      repo?: string | null;
      license?: string | null;
      author?: string | null;
      url?: string | null;
    } | null;
  } | null;
};
type ProjectTemplate = { name: string; description?: string | null; files: Array<{ name: string; content: string }> };

export const BASE_SYSTEM_PROMPT = OFFICIAL_DESIGNER_PROMPT;

export interface ComposeInput {
  skillBody?: string | undefined;
  skillName?: string | undefined;
  skillMode?:
    | 'prototype'
    | 'deck'
    | 'template'
    | 'design-system'
    | 'image'
    | 'video'
    | 'audio'
    | undefined;
  designSystemBody?: string | undefined;
  designSystemTitle?: string | undefined;
  // Craft references the active skill opted into via `od.craft.requires`.
  // The daemon resolves the slug list to file contents and concatenates
  // them with section headers; we inject them between the DESIGN.md and
  // the skill body so brand tokens win on conflict but craft rules
  // (letter-spacing, accent caps, anti-slop) cover everything below.
  craftBody?: string | undefined;
  craftSections?: string[] | undefined;
  vaultTemplateBody?: string | undefined;
  vaultAgentContextBody?: string | undefined;
  vaultCatalogBody?: string | undefined;
  // Project-level metadata captured by the new-project panel. Drives the
  // agent's understanding of artifact kind, fidelity, speaker-notes intent
  // and animation intent. Missing fields here are exactly what the
  // discovery form should re-ask the user about on turn 1.
  metadata?: ProjectMetadata | undefined;
  // The template the user picked in the From-template tab, when present.
  // Snapshot of HTML files that the agent should treat as a starting
  // reference rather than a fixed deliverable.
  template?: ProjectTemplate | undefined;
}

export function composeSystemPrompt({
  skillBody,
  skillName,
  skillMode,
  designSystemBody,
  designSystemTitle,
  craftBody,
  craftSections,
  vaultTemplateBody,
  vaultAgentContextBody,
  vaultCatalogBody,
  metadata,
  template,
}: ComposeInput): string {
  // Discovery + philosophy goes FIRST so its hard rules ("emit a form on
  // turn 1", "branch on brand on turn 2", "TodoWrite on turn 3", run
  // checklist + critique before <artifact>) win precedence over softer
  // wording later in the official base prompt.
  const parts: string[] = [
    DISCOVERY_AND_PHILOSOPHY,
    '\n\n---\n\n# Identity and workflow charter (background)\n\n',
    BASE_SYSTEM_PROMPT,
  ];

  if (designSystemBody && designSystemBody.trim().length > 0) {
    parts.push(
      `\n\n## Active design system${designSystemTitle ? ` — ${designSystemTitle}` : ''}\n\nTreat the following DESIGN.md as authoritative for color, typography, spacing, and component rules. Do not invent tokens outside this palette. When you copy the active skill's seed template, bind these tokens into its \`:root\` block before generating any layout.\n\n${designSystemBody.trim()}`,
    );
    parts.push(renderDesignSystemTransferProtocol('the active design system'));
  }

  if (craftBody && craftBody.trim().length > 0) {
    const sectionLabel =
      Array.isArray(craftSections) && craftSections.length > 0
        ? ` — ${craftSections.join(', ')}`
        : '';
    parts.push(
      `\n\n## Active craft references${sectionLabel}\n\nThe following craft rules are universal — they apply on top of the active design system above, regardless of brand. The DESIGN.md decides *which* tokens to use; craft rules decide *how* to use them. On any conflict between a craft rule and a brand DESIGN.md, the brand wins for token values; craft rules still apply to anything the brand does not override (letter-spacing, accent overuse caps, anti-slop patterns).\n\n${craftBody.trim()}`,
    );
  }

  if (skillBody && skillBody.trim().length > 0) {
    const preflight = derivePreflight(skillBody);
    parts.push(
      `\n\n## Active skill${skillName ? ` — ${skillName}` : ''}\n\nFollow this skill's workflow exactly.${preflight}\n\n${skillBody.trim()}`,
    );
  }

  const metaBlock = renderMetadataBlock(metadata, template, vaultTemplateBody, vaultCatalogBody, vaultAgentContextBody);
  if (metaBlock) parts.push(metaBlock);

  // Decks have a load-bearing framework (nav, counter, scroll JS, print
  // stylesheet for PDF stitching). Pin it last so it overrides any softer
  // wording earlier in the stack ("write a script that handles arrows…").
  //
  // We fire on either (a) the active skill is a deck skill OR (b) the
  // project metadata declares kind=deck. Case (b) catches projects created
  // without a skill (skill_id null) — without this, a deck-kind project
  // with no bound skill gets neither a skill seed nor the framework
  // skeleton, and the agent writes scaling / nav / print logic from scratch
  // with the same buggy `place-items: center` + transform pattern we keep
  // having to fix at runtime. Skill seeds (when present) win — they
  // already define their own opinionated framework (simple-deck's
  // scroll-snap, guizang-ppt's magazine layout) and re-pinning the generic
  // skeleton would conflict. The skill-seed path takes over via
  // `derivePreflight` above, so we only fire the generic skeleton when no
  // skill seed is on offer.
  const isDeckProject = skillMode === 'deck' || metadata?.kind === 'deck';
  const hasSkillSeed =
    !!skillBody && /assets\/template(?:-[a-z0-9-]+)?\.html/.test(skillBody);
  if (metadata?.kind === 'deck') {
    parts.push(`\n\n---\n\n${OPENPPT_DECK_CONTRACT}`);
  } else if (isDeckProject && !hasSkillSeed) {
    parts.push(`\n\n---\n\n${DECK_FRAMEWORK_DIRECTIVE}`);
  }

  const hasDeckMedia =
    metadata?.kind === 'deck' &&
    (metadata.deckMedia?.enabled === true || metadata.deckMedia?.required === true);
  if (hasDeckMedia) {
    parts.push(`\n\n${OPENPPT_DECK_MEDIA_CONTRACT}`);
  }

  const isMediaSurface =
    skillMode === 'image' ||
    skillMode === 'video' ||
    skillMode === 'audio' ||
    metadata?.kind === 'image' ||
    metadata?.kind === 'video' ||
    metadata?.kind === 'audio';
  if (isMediaSurface) {
    parts.push(MEDIA_GENERATION_CONTRACT);
  }

  return parts.join('');
}

function renderMetadataBlock(
  metadata: ProjectMetadata | undefined,
  template: ProjectTemplate | undefined,
  vaultTemplateBody?: string,
  vaultCatalogBody?: string,
  vaultAgentContextBody?: string,
): string {
  if (!metadata) return '';
  const lines: string[] = [];
  lines.push('\n\n## Project metadata');
  lines.push(
    'These are the structured choices the user made (or skipped) when creating this project. Treat known fields as authoritative; for any field marked "(unknown — ask)" you MUST include a matching question in your turn-1 discovery form.',
  );
  lines.push('');
  lines.push(`- **kind**: ${metadata.kind}`);
  if (metadata.intent === 'live-artifact') {
    lines.push(
      '- **intent**: live-artifact — the user chose New live artifact. The first output should be a live artifact/dashboard/report, not a one-off static mockup. Prefer the `live-artifact` skill workflow when available, keep source data compact, and register through the daemon live-artifact tool path once that wrapper/tooling is available.',
    );
    lines.push(
      '- **connector-source rule**: if the user names a connector/source (for example Notion) and daemon connector tools are available, list connectors before asking where the data comes from. When the named connector is `connected`, use its read-only tools and ask follow-up questions only for missing topic/page/database details, multiple equally plausible matches, or an unconnected/missing connector.',
    );
  }

  if (metadata.kind === 'prototype') {
    lines.push(
      `- **fidelity**: ${metadata.fidelity ?? '(unknown — ask: wireframe vs high-fidelity)'}`,
    );
  }
  if (metadata.kind === 'deck') {
    lines.push(
      `- **speakerNotes**: ${typeof metadata.speakerNotes === 'boolean' ? metadata.speakerNotes : '(unknown — ask: include speaker notes?)'}`,
    );
    if (metadata.deckMedia?.enabled || metadata.deckMedia?.required) {
      const deckMedia = metadata.deckMedia;
      lines.push(`- **deckMedia**: enabled${deckMedia.required ? ' / required' : ''}`);
      lines.push(`- **deckMediaImageModel**: ${deckMedia.imageModel ?? '(not configured - do not assume a default image model)'}`);
      lines.push(`- **deckMediaAspect**: ${deckMedia.imageAspect ?? '16:9'}`);
      if (deckMedia.keySlidePolicy) {
        lines.push(`- **deckMediaKeySlidePolicy**: ${deckMedia.keySlidePolicy}`);
      }
      if (deckMedia.source) {
        lines.push(`- **deckMediaSource**: ${deckMedia.source}`);
      }
      if (deckMedia.capturedFrom) {
        lines.push(`- **deckMediaCapturedFrom**: ${deckMedia.capturedFrom}`);
      }
    }
      if (metadata.vaultTemplate) {
        const vault = metadata.vaultTemplate;
        lines.push(`- **vaultTemplate**: ${vault.title ?? 'Untitled Vault template'}${vault.slug ? ` (${vault.slug})` : ''}`);
      if (vault.kind) lines.push(`- **vaultContextKind**: ${vault.kind}`);
      if (vault.packageType) lines.push(`- **vaultPackageType**: ${vault.packageType}`);
      if (vault.sourceHost || vault.sourceUrl) {
        lines.push(`- **vaultSource**: ${vault.sourceHost ?? ''}${vault.sourceUrl ? ` — ${vault.sourceUrl}` : ''}`);
      }
      if (vault.skillPath) lines.push(`- **vaultSkillPath**: ${vault.skillPath}`);
      if (vault.capabilitiesPath) lines.push(`- **vaultCapabilitiesPath**: ${vault.capabilitiesPath}`);
      if (vault.manifestPath) lines.push(`- **vaultManifestPath**: ${vault.manifestPath}`);
      if (Array.isArray(vault.references) && vault.references.length > 0) {
        lines.push(`- **vaultReferences**: ${vault.references.join(', ')}`);
      }
      if (vault.activationPrompt) lines.push(`- **vaultActivationPrompt**: ${vault.activationPrompt}`);
      if (vault.summary) lines.push(`- **vaultSummary**: ${vault.summary}`);
      if (vault.archetype) lines.push(`- **vaultArchetype**: ${vault.archetype}`);
      if (vault.visualThesis) lines.push(`- **vaultVisualThesis**: ${vault.visualThesis}`);
      if (Array.isArray(vault.toneTags) && vault.toneTags.length > 0) lines.push(`- **vaultToneTags**: ${vault.toneTags.join(', ')}`);
      if (Array.isArray(vault.useCaseTags) && vault.useCaseTags.length > 0) lines.push(`- **vaultUseCases**: ${vault.useCaseTags.join(', ')}`);
      if (Array.isArray(vault.audienceFit) && vault.audienceFit.length > 0) lines.push(`- **vaultAudienceFit**: ${vault.audienceFit.join(', ')}`);
      if (vault.contentDensity) {
        lines.push(`- **vaultContentDensity**: ${typeof vault.contentDensity === 'string' ? vault.contentDensity : [vault.contentDensity.level, vault.contentDensity.rationale].filter(Boolean).join(' — ')}`);
      }
      if (Array.isArray(vault.narrativeFit) && vault.narrativeFit.length > 0) lines.push(`- **vaultNarrativeFit**: ${vault.narrativeFit.join(', ')}`);
      if (Array.isArray(vault.matchingRationale) && vault.matchingRationale.length > 0) lines.push(`- **vaultMatchingRationale**: ${vault.matchingRationale.join(' / ')}`);
      if (Array.isArray(vault.avoidWhen) && vault.avoidWhen.length > 0) lines.push(`- **vaultAvoidWhen**: ${vault.avoidWhen.join(' / ')}`);
      if (typeof vault.mediaPromptGrammar === 'string' && vault.mediaPromptGrammar.trim().length > 0) {
        lines.push(`- **vaultMediaPromptGrammar**: ${vault.mediaPromptGrammar.trim()}`);
      } else if (Array.isArray(vault.mediaPromptGrammar) && vault.mediaPromptGrammar.length > 0) {
        lines.push(`- **vaultMediaPromptGrammar**: ${vault.mediaPromptGrammar.map(cleanMetadataText).filter(Boolean).join(' / ')}`);
      }
      if (vault.colorRoles) {
        const roles = [
          vault.colorRoles.background ? `background ${vault.colorRoles.background}` : null,
          vault.colorRoles.text ? `text ${vault.colorRoles.text}` : null,
          vault.colorRoles.brandPrimary ? `primary ${vault.colorRoles.brandPrimary}` : null,
          vault.colorRoles.brandSecondary ? `secondary ${vault.colorRoles.brandSecondary}` : null,
          vault.colorRoles.surfaceAlternate ? `altSurface ${vault.colorRoles.surfaceAlternate}` : null,
          vault.colorRoles.surfaceDeep ? `deepSurface ${vault.colorRoles.surfaceDeep}` : null,
        ].filter(Boolean);
        if (roles.length > 0) lines.push(`- **vaultColorRoles**: ${roles.join(', ')}`);
        if (Array.isArray(vault.colorRoles.accentPalette)) {
          const palette = vault.colorRoles.accentPalette
            .map((entry) => {
              const hex = entry && typeof entry.hex === 'string' ? entry.hex.trim() : '';
              if (!hex) return '';
              const label = entry.canonicalRole || entry.role;
              return label ? `${hex} (${label})` : hex;
            })
            .filter(Boolean)
            .slice(0, 10);
          if (palette.length > 0) lines.push(`- **vaultAccentPalette**: ${palette.join(', ')}`);
        }
      }
      if (vault.typographyRoles) {
        const roles = [
          vault.typographyRoles.display ? `display ${vault.typographyRoles.display}` : null,
          (vault.typographyRoles.body || vault.typographyRoles.primary) ? `body ${vault.typographyRoles.body ?? vault.typographyRoles.primary}` : null,
          vault.typographyRoles.mono ? `mono ${vault.typographyRoles.mono}` : null,
        ].filter(Boolean);
        if (roles.length > 0) lines.push(`- **vaultTypographyRoles**: ${roles.join(', ')}`);
      }
      if (vault.openSlideGuidance) {
        const guidance = vault.openSlideGuidance;
        if (guidance.direction) lines.push(`- **vaultSlideDirection**: ${guidance.direction}`);
        if (guidance.coverApproach) lines.push(`- **vaultCoverApproach**: ${guidance.coverApproach}`);
        if (Array.isArray(guidance.layoutApproach) && guidance.layoutApproach.length > 0) {
          lines.push(`- **vaultLayoutApproach**: ${guidance.layoutApproach.join(' / ')}`);
        }
        if (Array.isArray(guidance.motionApproach) && guidance.motionApproach.length > 0) {
          lines.push(`- **vaultMotionApproach**: ${guidance.motionApproach.join(' / ')}`);
        }
      }
      lines.push(...renderVaultComponentMotionRecipesBlock(vault.componentMotionRecipes));
      if (vault.openSlideThemePath) {
        lines.push(`- **vaultOpenSlideTheme**: ${vault.openSlideThemePath}`);
      }
      lines.push(
        '- **visual-style status**: LOCKED by the Vault template. Do not ask the user to confirm visual tone, brand context, color direction, or a second direction picker. Use the Vault template as the authoritative visual system and only ask for missing content or narrative details.',
      );
      if (vaultAgentContextBody && vaultAgentContextBody.trim().length > 0) {
        lines.push('');
        lines.push('### Active Design Vault agent context');
        lines.push(
          'This is the authoritative design skill / prompt context. The agent must read and follow it before writing `slides/<slideId>/index.tsx`.',
        );
        const safe = vaultAgentContextBody.replace(/```/g, '`\u200b`\u200b`');
        const truncated =
          safe.length > 32000
            ? `${safe.slice(0, 32000)}\n... (truncated ${safe.length - 32000} chars)`
            : safe;
        lines.push('');
        lines.push('```markdown');
        lines.push(truncated);
        lines.push('```');
        lines.push(...renderVaultPreGenerationTransferLines(vault.title ?? vault.slug ?? 'the selected Vault system'));
      } else if (vaultTemplateBody && vaultTemplateBody.trim().length > 0) {
        lines.push('');
        lines.push('### Active Vault `open-slide-theme.md`');
        lines.push(
          'This theme guidance is authoritative for the SFA deck. Bind its palette, typography, layout, component language, and anti-patterns into `slides/<slideId>/index.tsx`.',
        );
        const safe = vaultTemplateBody.replace(/```/g, '`\u200b`\u200b`');
        const truncated =
          safe.length > 8000
            ? `${safe.slice(0, 8000)}\n... (truncated ${safe.length - 8000} chars)`
            : safe;
        lines.push('');
        lines.push('```markdown');
        lines.push(truncated);
        lines.push('```');
        lines.push(...renderVaultPreGenerationTransferLines(vault.title ?? vault.slug ?? 'the selected Vault system'));
      }
    } else if (vaultAgentContextBody && vaultAgentContextBody.trim().length > 0) {
      lines.push(
        '- **visual-style status**: LOCKED by the active Design Vault design system. The user selected the style during chat or project configuration; use the resolved Vault context as the authoritative visual system and only ask for missing content or narrative details.',
      );
      lines.push('');
      lines.push('### Active Design Vault agent context');
      lines.push(
        'This is the authoritative design skill / prompt context resolved from the active Design Vault design system. Read it before writing `slides/<slideId>/index.tsx`.',
      );
      const safe = vaultAgentContextBody.replace(/```/g, '`\u200b`\u200b`');
      const truncated =
        safe.length > 32000
          ? `${safe.slice(0, 32000)}\n... (truncated ${safe.length - 32000} chars)`
          : safe;
      lines.push('');
      lines.push('```markdown');
      lines.push(truncated);
      lines.push('```');
      lines.push(...renderVaultPreGenerationTransferLines('the active Design Vault system'));
    } else {
      lines.push(
        '- **visual-style status**: DEFERRED TO CHAT. The user should choose the style template during the conversation, after the brief/audience/content constraints are known. Do not treat project creation as the style-selection step.',
      );
      if (vaultCatalogBody && vaultCatalogBody.trim().length > 0) {
        lines.push('');
        lines.push('### Available Design Vault style templates');
        lines.push(
          'Use this catalog to recommend 2-3 templates after the discovery answers are known. Explain the reason for each recommendation using task fit, audience fit, content density, and visual posture. Ask the user to choose one; after they choose, read the selected `openSlideThemePath` if present and treat that theme as authoritative.',
        );
        lines.push('');
        lines.push(vaultCatalogBody.trim());
      } else {
        lines.push(
          '- **vaultCatalog**: unavailable. Do not replace Design Vault selection with generic visual-tone chips. Tell the user the Design Vault catalog/context is unavailable, ask them to reconnect or continue explicitly without a Vault template, and only proceed without Vault after that choice.',
        );
      }
    }
  }
  if (metadata.kind === 'template') {
    lines.push(
      `- **animations**: ${typeof metadata.animations === 'boolean' ? metadata.animations : '(unknown — ask: include motion/animations?)'}`,
    );
    if (metadata.templateLabel) {
      lines.push(`- **template**: ${metadata.templateLabel}`);
    }
  }
  if (metadata.kind === 'image') {
    lines.push(
      `- **imageModel**: ${metadata.imageModel ?? '(unknown — ask: which image model to use)'}`,
    );
    lines.push(
      `- **aspectRatio**: ${metadata.imageAspect ?? '(unknown — ask: 1:1, 16:9, 9:16, 4:3, 3:4)'}`,
    );
    if (metadata.imageStyle) {
      lines.push(`- **styleNotes**: ${metadata.imageStyle}`);
    }
    if (
      metadata.promptTemplate?.title &&
      typeof metadata.promptTemplate.prompt === 'string' &&
      metadata.promptTemplate.prompt.trim().length > 0
    ) {
      lines.push(`- **referenceTemplate**: ${metadata.promptTemplate.title}`);
    }
    lines.push('');
    lines.push(
      'This is an **image** project. Plan the prompt carefully, then dispatch via the **media generation contract** using `"$OD_NODE_BIN" "$OD_BIN" media generate --surface image --model <imageModel>`. Do NOT emit `<artifact>` HTML for media surfaces.',
    );
  }
  if (metadata.kind === 'video') {
    lines.push(
      `- **videoModel**: ${metadata.videoModel ?? '(unknown — ask: which video model to use)'}`,
    );
    lines.push(
      `- **lengthSeconds**: ${typeof metadata.videoLength === 'number' ? metadata.videoLength : '(unknown — ask: 3s / 5s / 10s)'}`,
    );
    lines.push(
      `- **aspectRatio**: ${metadata.videoAspect ?? '(unknown — ask: 16:9, 9:16, 1:1)'}`,
    );
    if (
      metadata.promptTemplate?.title &&
      typeof metadata.promptTemplate.prompt === 'string' &&
      metadata.promptTemplate.prompt.trim().length > 0
    ) {
      lines.push(`- **referenceTemplate**: ${metadata.promptTemplate.title}`);
    }
    lines.push('');
    lines.push(
      'This is a **video** project. Plan the shotlist and motion, then dispatch via the **media generation contract** using `"$OD_NODE_BIN" "$OD_BIN" media generate --surface video --model <videoModel> --length <seconds> --aspect <ratio>`. Do NOT emit `<artifact>` HTML.',
    );
    if (metadata.videoModel === 'hyperframes-html') {
      lines.push(
        'Special case: `hyperframes-html` is a local HTML-to-MP4 renderer, not a photoreal text-to-video model. Treat it like a motion design renderer, ask at most one clarifying question, then dispatch immediately.',
      );
    }
  }
  if (metadata.kind === 'audio') {
    lines.push(
      `- **audioKind**: ${metadata.audioKind ?? '(unknown — ask: music / speech / sfx)'}`,
    );
    lines.push(
      `- **audioModel**: ${metadata.audioModel ?? '(unknown — ask: which audio model to use)'}`,
    );
    lines.push(
      `- **durationSeconds**: ${typeof metadata.audioDuration === 'number' ? metadata.audioDuration : '(unknown — ask: target duration)'}`,
    );
    if (metadata.voice) {
      lines.push(`- **voice**: ${metadata.voice}`);
    } else if (metadata.audioKind === 'speech') {
      lines.push('- **voice**: (unknown — ask: voice id / accent / pacing)');
    }
    lines.push('');
    lines.push(
      'This is an **audio** project. Lock the content intent first, then dispatch via the **media generation contract** using `"$OD_NODE_BIN" "$OD_BIN" media generate --surface audio --audio-kind <kind> --model <audioModel> --duration <seconds>` and add `--voice <voice-id>` for speech when you have a provider-specific voice id. Do NOT emit `<artifact>` HTML.',
    );
  }

  if (metadata.inspirationDesignSystemIds && metadata.inspirationDesignSystemIds.length > 0) {
    lines.push(
      `- **inspirationDesignSystemIds**: ${metadata.inspirationDesignSystemIds.join(', ')} — the user picked these systems as *additional* inspiration alongside the primary one. Borrow palette accents, typographic personality, or component patterns from them; don't replace the primary system's tokens.`,
    );
  }

  // Curated prompt template reference for image/video projects. Inlined
  // verbatim (with light truncation) so the agent can borrow structure,
  // mood and phrasing without a separate fetch. The user may have edited
  // the body before clicking Create — those edits land here and are now
  // authoritative for the brief.
  if (
    (metadata.kind === 'image' || metadata.kind === 'video') &&
    metadata.promptTemplate &&
    typeof metadata.promptTemplate.prompt === 'string' &&
    metadata.promptTemplate.prompt.trim().length > 0
  ) {
    const tpl = metadata.promptTemplate;
    lines.push('');
    lines.push(`### Reference prompt template — "${tpl.title ?? 'untitled'}"`);
    const meta = [];
    if (tpl.category) meta.push(`category: ${tpl.category}`);
    if (tpl.model) meta.push(`suggested model: ${tpl.model}`);
    if (tpl.aspect) meta.push(`aspect: ${tpl.aspect}`);
    if (Array.isArray(tpl.tags) && tpl.tags.length > 0) {
      meta.push(`tags: ${tpl.tags.join(', ')}`);
    }
    if (meta.length > 0) lines.push(meta.join(' · '));
    if (tpl.summary) {
      lines.push('');
      lines.push(tpl.summary);
    }
    lines.push('');
    lines.push(
      'The user picked this template as inspiration. Treat it as a structural and stylistic reference: borrow composition, palette cues, lighting language, lens/motion direction, and the level of detail. Adapt the wording to the user\'s actual subject and brief — do NOT generate the template subject verbatim. If a field above is unknown the user wants you to follow the template\'s defaults.',
    );
    // Escape triple-backticks so a user who pastes ``` into the editable
    // template body can't break out of the markdown fence below and inject
    // free-form instructions into the agent's system prompt.
    const safe = (tpl.prompt ?? '').replace(/```/g, '`\u200b`\u200b`');
    const truncated =
      safe.length > 4000
        ? `${safe.slice(0, 4000)}\n… (truncated ${safe.length - 4000} chars)`
        : safe;
    lines.push('');
    lines.push('```text');
    lines.push(truncated);
    lines.push('```');
    if (tpl.source) {
      const author = tpl.source.author ? ` by ${tpl.source.author}` : '';
      lines.push('');
      lines.push(
        `Source: ${tpl.source.repo}${author} — license ${tpl.source.license ?? 'unspecified'}. Preserve attribution if you echo the template language directly.`,
      );
    }
  }

  if (metadata.kind === 'template' && template && template.files.length > 0) {
    lines.push('');
    lines.push(
      `### Template reference — "${template.name}"${template.description ? ` (${template.description})` : ''}`,
    );
    lines.push(
      'These HTML snapshots are what the user wants to start FROM. Read them as a stylistic + structural reference. You may copy structure, palette, typography, and component patterns; you may adapt them to the new brief; do NOT ship them verbatim. The agent should still produce its own artifact, just one that visibly inherits this template\'s design language.',
    );
    for (const f of template.files) {
      // Cap each file at ~12k chars so a giant template doesn't blow out
      // the system prompt budget. The agent gets enough to read structure.
      const truncated =
        f.content.length > 12000
          ? `${f.content.slice(0, 12000)}\n<!-- … truncated (${f.content.length - 12000} chars omitted) -->`
          : f.content;
      lines.push('');
      lines.push(`#### \`${f.name}\``);
      lines.push('```html');
      lines.push(truncated);
      lines.push('```');
    }
  }

  return lines.join('\n');
}

function renderDesignSystemTransferProtocol(label: string): string {
  return [
    '',
    '## Design-system transfer protocol',
    '',
    `Before writing files, translate ${label} into a project-specific visual plan. This is a pre-generation thinking step, not a post-hoc audit.`,
    '',
    '- Start with source recognition: identify the 3-5 visual anchors that make the source recognizable without reading its title.',
    '- Map the user content to source archetypes first: title, case-study, data, image, list/table row, form/contact, process, or whichever archetypes the system documents.',
    '- Treat tokens as the last mile. Palette and fonts are necessary, but layout rhythm, media treatment, chrome, component roles, density, and interaction language carry more of the style.',
    '- For each page or screen, choose a source-derived composition reason before choosing grid/card/list defaults.',
    '- If generated media is required, plan the slide image slot before dispatch: page role, container size, aspect ratio, fit/crop policy, focal-safe zone, adjacent text/chrome relationship, then write image prompts using the same source anchors: crop, contrast, image density, accent behavior, caption/chrome relationship, and motion/state cues.',
    '- Treat generated media as a component of the design system. The image prompt should name the source-derived media grammar, not just the slide topic plus palette.',
    '- If evidence is weak, preserve relationship-level traits and mark uncertainty in your working plan rather than inventing a confident house style.',
    '- Embed the plan in the output structure and component names. Do not render this analysis as visible user-facing design prose.',
  ].join('\n');
}

function renderVaultPreGenerationTransferLines(label: string): string[] {
  return [
    '',
    '### Pre-generation Design Vault transfer plan',
    `Before editing SFA deck source, translate ${label} into a slide-specific style plan:`,
    '- source anchors: what must be visible for immediate recognition',
    '- page archetype map: which Vault slide archetype each slide uses and why',
    '- layout grammar: grids, chrome, media regions, list/table behavior, and density',
    '- media slot plan: for every generated/selected image, define page, output path, container coordinates or CSS size, final aspect ratio, fit/crop behavior, focal-safe zone, and surrounding text/chrome alignment before generation',
    '- media prompt grammar: how generated images should inherit the same visual system',
    '- media dispatch rule: every `od media generate --surface image` prompt must include the media prompt grammar, or rely on the daemon-injected SFA media prompt style context when available',
    '- motion grammar: only the source-observed motion/state language, not generic helper animations',
    '- adaptation rule: preserve visual relationships and component roles when the deck content differs from the source subject',
    'Use this plan to write `slides/<slideId>/index.tsx`; do not present the plan as deck content unless the user explicitly asks for an audit.',
  ];
}

function cleanMetadataText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function cleanMetadataList(value: unknown, max = 6): string[] {
  return Array.isArray(value)
    ? value.map(cleanMetadataText).filter(Boolean).slice(0, max)
    : [];
}

function renderVaultComponentMotionRecipesBlock(
  recipes: NonNullable<ProjectMetadata['vaultTemplate']>['componentMotionRecipes'],
): string[] {
  if (!Array.isArray(recipes) || recipes.length === 0) return [];
  const normalized = recipes
    .filter((recipe) => recipe && typeof recipe === 'object')
    .map((recipe) => {
      const id = cleanMetadataText(recipe.id);
      const component = cleanMetadataText(recipe.component);
      if (!id || !component) return null;
      const timing = recipe.timing && typeof recipe.timing === 'object'
        ? recipe.timing
        : {} as Record<string, unknown>;
      return {
        id,
        component,
        role: cleanMetadataText(recipe.role),
        trigger: cleanMetadataText(recipe.trigger),
        statePair: cleanMetadataText(recipe.statePair),
        properties: cleanMetadataList(recipe.properties),
        timing: [
          cleanMetadataText(timing.duration) ? `duration ${cleanMetadataText(timing.duration)}` : null,
          cleanMetadataText(timing.easing) ? `easing ${cleanMetadataText(timing.easing)}` : null,
          cleanMetadataText(timing.delay) ? `delay ${cleanMetadataText(timing.delay)}` : null,
          cleanMetadataText(timing.stagger) ? `stagger ${cleanMetadataText(timing.stagger)}` : null,
        ].filter(Boolean).join(', '),
        pptAdapter: cleanMetadataList(recipe.pptAdapter),
      };
    })
    .filter((recipe): recipe is NonNullable<typeof recipe> => recipe !== null)
    .slice(0, 6);
  if (normalized.length === 0) return [];
  const lines = [
    '',
    '### vaultComponentMotionRecipes',
    'These are Design Vault component-scoped motion recipes. Prefer applying a matching recipe to the matching component role before inventing a new animation.',
  ];
  for (const recipe of normalized) {
    lines.push(
      `- id=${recipe.id} | component=${recipe.component} | role=${recipe.role || 'unspecified'} | trigger=${recipe.trigger || 'unspecified'} | statePair=${recipe.statePair || 'unspecified'} | properties=${recipe.properties.join(', ') || 'unspecified'} | timing=${recipe.timing || 'unspecified'} | pptAdapter=${recipe.pptAdapter.join(' / ') || 'unspecified'}`,
    );
  }
  lines.push(
    'Motion implementation rules: in generated SFA deck TSX, use `MotionStyles`, `motionFromRecipe`, `motionAttrs`, and `data-osd-motion-id` for recipe-backed components; CSS motion must include a `prefers-reduced-motion` fallback; keep `data-osd-motion-id` in the DOM so PPTX export can capture the recipe metadata.',
  );
  return lines;
}

/**
 * Detect the seed/references pattern shipped by the upgraded
 * web-prototype / mobile-app / simple-deck / guizang-ppt skills, and
 * inject a hard pre-flight rule that lists which side files to Read
 * before doing anything else. The skill body's own workflow already says
 * this — but skills get truncated under context pressure and the agent
 * sometimes skips Step 0. A short up-front directive helps.
 *
 * Returns an empty string when the skill ships no side files (legacy
 * SKILL.md-only skills) so we don't add noise.
 */
function derivePreflight(skillBody: string): string {
  const refs: string[] = [];
  const pushRef = (ref: string) => {
    const item = `\`${ref}\``;
    if (!refs.includes(item)) refs.push(item);
  };
  const hasSourcePackage = /(?:^|[\/\s`"'])skill\/source(?:\/|$)|(?:^|[\/\s`"'])source\/SKILL\.md/.test(skillBody);
  const hasSwissSource =
    hasSourcePackage ||
    /swiss-layout-lock\.md|layouts-swiss\.md|themes-swiss\.md|template-swiss\.html|validate-swiss-deck\.mjs/.test(skillBody);

  if (hasSourcePackage || /source\/SKILL\.md/.test(skillBody)) pushRef('source/SKILL.md');
  if (hasSwissSource && /swiss-layout-lock\.md|source\/references/.test(skillBody)) pushRef('source/references/swiss-layout-lock.md');
  if (hasSwissSource && /layouts-swiss\.md|source\/references/.test(skillBody)) pushRef('source/references/layouts-swiss.md');
  if (hasSwissSource && /themes-swiss\.md|source\/references/.test(skillBody)) pushRef('source/references/themes-swiss.md');
  if (hasSwissSource && /image-prompts\.md|source\/references/.test(skillBody)) pushRef('source/references/image-prompts.md');
  if (hasSwissSource && /template-swiss\.html|source\/assets/.test(skillBody)) pushRef('source/assets/template-swiss.html');
  if (hasSwissSource && /validate-swiss-deck\.mjs|source\/scripts/.test(skillBody)) pushRef('source/scripts/validate-swiss-deck.mjs');

  if (/assets\/template\.html/.test(skillBody)) pushRef('assets/template.html');
  if (/references\/layouts\.md/.test(skillBody)) pushRef('references/layouts.md');
  if (/references\/themes\.md/.test(skillBody)) pushRef('references/themes.md');
  if (/references\/components\.md/.test(skillBody)) pushRef('references/components.md');
  if (/references\/checklist\.md/.test(skillBody)) pushRef('references/checklist.md');
  if (refs.length === 0) return '';
  const sourceRule = hasSourcePackage
    ? ' For Design Vault skills, the wrapper is routing context; `source/` is the upstream source of truth for concrete capabilities, templates, and validators.'
    : '';
  return ` **Pre-flight (do this before any other tool):** Read ${refs.join(', ')} via the path written in the skill-root preamble.${sourceRule} The seed template defines the class system you'll paste into; the layouts file is the only acceptable source of section/screen/slide skeletons; the checklist and validator are your P0/P1/P2 gate before emitting \`<artifact>\`. Skipping this step is the #1 reason output regresses to generic AI-slop.`;
}
