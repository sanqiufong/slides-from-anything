type VaultTemplateLike = {
  slug?: string | null;
  title?: string | null;
  sourceHost?: string | null;
  sourceUrl?: string | null;
  summary?: string | null;
  archetype?: string | null;
  visualThesis?: string | null;
  toneTags?: string[] | null;
  useCaseTags?: string[] | null;
  slidePatterns?: string[] | null;
  layoutIntensity?: string | null;
  mediaPromptGrammar?: string | string[] | null;
  contentDensity?: string | { level?: string | null; rationale?: string | null } | null;
  colorRoles?: {
    background?: string | null;
    text?: string | null;
    brandPrimary?: string | null;
    brandSecondary?: string | null;
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
};

type ProjectMetadataLike = {
  kind?: string | null;
  deckMedia?: {
    enabled?: boolean | null;
    required?: boolean | null;
  } | null;
  vaultTemplate?: VaultTemplateLike | null;
} | null;

export interface OpenPptMediaPromptEnhanceInput {
  surface?: unknown;
  prompt?: unknown;
  output?: unknown;
  projectMetadata?: ProjectMetadataLike;
  designSystemId?: unknown;
  vaultAgentContextBody?: string | undefined;
}

export const OPENPPT_MEDIA_STYLE_CONTEXT_MARKER = 'SFA media prompt style context';

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function cleanList(value: unknown, max = 6): string[] {
  return Array.isArray(value)
    ? value.map(cleanText).filter(Boolean).slice(0, max)
    : [];
}

function line(label: string, value: unknown): string | null {
  const text = cleanText(value);
  return text ? `- ${label}: ${text}` : null;
}

function listLine(label: string, values: unknown): string | null {
  const list = cleanList(values);
  return list.length > 0 ? `- ${label}: ${list.join(', ')}` : null;
}

function colorRolesLine(vault: VaultTemplateLike | undefined): string | null {
  const roles = vault?.colorRoles;
  if (!roles) return null;
  const items = [
    roles.background ? `background ${roles.background}` : null,
    roles.text ? `text ${roles.text}` : null,
    roles.brandPrimary ? `primary ${roles.brandPrimary}` : null,
    roles.brandSecondary ? `secondary ${roles.brandSecondary}` : null,
  ].filter(Boolean);
  return items.length > 0 ? `- color roles: ${items.join(', ')}` : null;
}

function typographyRolesLine(vault: VaultTemplateLike | undefined): string | null {
  const roles = vault?.typographyRoles;
  if (!roles) return null;
  const items = [
    roles.display ? `display ${roles.display}` : null,
    roles.body || roles.primary ? `body ${roles.body ?? roles.primary}` : null,
    roles.mono ? `mono ${roles.mono}` : null,
  ].filter(Boolean);
  return items.length > 0 ? `- typography roles: ${items.join(', ')}` : null;
}

function contentDensityLine(vault: VaultTemplateLike | undefined): string | null {
  const density = vault?.contentDensity;
  if (!density) return null;
  if (typeof density === 'string') return line('content density', density);
  const joined = [density.level, density.rationale].map(cleanText).filter(Boolean).join(' - ');
  return joined ? `- content density: ${joined}` : null;
}

function takeSectionLines(body: string, headingPattern: RegExp, maxLines: number): string[] {
  const lines = body.split(/\r?\n/);
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i]?.trim() ?? '';
    if (!headingPattern.test(current)) continue;
    if (current) found.push(current.replace(/^#+\s*/, ''));
    for (let j = i + 1; j < lines.length && found.length < maxLines; j += 1) {
      const next = lines[j]?.trim() ?? '';
      if (/^#{1,4}\s+\S/.test(next)) break;
      if (!next) continue;
      if (next.length > 220) {
        found.push(`${next.slice(0, 220)}...`);
      } else {
        found.push(next);
      }
    }
    break;
  }
  return found;
}

export function summarizeVaultContextForMediaPrompt(body?: string): string[] {
  const text = cleanText(body);
  if (!text) return [];
  const sections = [
    takeSectionLines(body!, /^#+\s*Visual Thesis\b/i, 3),
    takeSectionLines(body!, /^#+\s*Visual DNA\b/i, 5),
    takeSectionLines(body!, /^#+\s*Layout Grammar\b/i, 5),
    takeSectionLines(body!, /^#+\s*Motion And Interaction\b/i, 4),
    takeSectionLines(body!, /^#+\s*Color Roles\b/i, 5),
    takeSectionLines(body!, /^#+\s*Typography\b/i, 4),
    takeSectionLines(body!, /^#+\s*(Anti[- ]patterns|Quality Gates)\b/i, 4),
  ].flat();
  const seen = new Set<string>();
  const unique = sections
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  const joined: string[] = [];
  let budget = 1200;
  for (const item of unique) {
    if (budget <= 0) break;
    const next = item.length > budget ? `${item.slice(0, Math.max(0, budget - 3))}...` : item;
    joined.push(next);
    budget -= next.length + 1;
  }
  return joined;
}

export function buildOpenPptMediaStyleContext(input: OpenPptMediaPromptEnhanceInput): string[] {
  const metadata = input.projectMetadata;
  const vault = metadata?.vaultTemplate ?? undefined;
  const designSystemId = cleanText(input.designSystemId);
  const inferredVaultSlug = designSystemId.startsWith('dv-') ? designSystemId.slice(3) : '';
  const activeName = cleanText(vault?.title) || cleanText(vault?.slug) || inferredVaultSlug;
  const contextLines = summarizeVaultContextForMediaPrompt(input.vaultAgentContextBody);

  const lines = [
    `${OPENPPT_MEDIA_STYLE_CONTEXT_MARKER}:`,
    line('active Vault design system', activeName || 'not resolved; use the slide design system and Media Slot Plan'),
    line('source', [vault?.sourceHost, vault?.sourceUrl].map(cleanText).filter(Boolean).join(' - ')),
    line('visual thesis', vault?.visualThesis || vault?.summary),
    line('archetype', vault?.archetype),
    listLine('tone tags', vault?.toneTags),
    listLine('slide patterns', vault?.slidePatterns),
    typeof vault?.mediaPromptGrammar === 'string'
      ? line('media prompt grammar', vault.mediaPromptGrammar)
      : listLine('media prompt grammar', vault?.mediaPromptGrammar),
    contentDensityLine(vault),
    colorRolesLine(vault),
    typographyRolesLine(vault),
    listLine('layout guidance', vault?.openSlideGuidance?.layoutApproach),
    listLine('motion guidance', vault?.openSlideGuidance?.motionApproach),
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);

  if (contextLines.length > 0) {
    lines.push('- source context anchors:');
    for (const item of contextLines.slice(0, 10)) {
      lines.push(`  - ${item}`);
    }
  }

  lines.push(
    '- slot-first media rule: compose the image for the planned slide container, not as a generic standalone picture. The prompt should name the intended page, output filename, container dimensions or CSS size, final aspect ratio, fit/crop policy, focal-safe zone, and any negative space needed for adjacent typography or chrome.',
    '- crop-safety hard rule: treat the generated bitmap as the final visible crop. Keep every meaningful label, icon, arrow, diagram node, UI panel, person, and text block fully inside an inner safe area with quiet padding around all four edges. No half objects, cropped words, clipped arrows, cut-off cards, or lines that imply the diagram continues outside the canvas.',
    '- information-graphic rule: if the image contains diagrams, UI, annotations, process flows, layout examples, or any readable text, make it a complete self-contained panel suitable for object-fit: contain. For these images, do not rely on object-fit: cover, edge cropping, or post-generation CSS cropping to hide overflow.',
    '- image-language transfer: inherit framing, crop, density, lighting/material, line/border language, caption/chrome relationship, and source-observed component roles; do not merely recolor a generic image.',
    '- diagram/process rule: if the slide asks for a diagram, translate the active design system into diagram marks and media treatment. Avoid generic cyber glow, fantasy scenes, neon HUDs, stock SaaS gradients, or cinematic concept art unless those are explicit source evidence.',
    '- asset boundary rule: generated assets should not bake in slide titles, page numbers, captions, borders, signatures, or surrounding deck chrome unless those are the image subject itself; those elements belong in the slide TSX around the image slot.',
    '- deck-fit rule: make the image feel native inside a 1920x1080 SFA slide, with useful negative space for surrounding text/chrome and no visible prompt text.',
  );

  return lines;
}

export function enhanceOpenPptMediaPrompt(input: OpenPptMediaPromptEnhanceInput): string | undefined {
  const original = typeof input.prompt === 'string' ? input.prompt : undefined;
  if (input.surface !== 'image') return original;
  if (input.projectMetadata?.kind !== 'deck') return original;

  const base = cleanText(original) || 'A high-quality generated image for an SFA deck slide.';
  if (base.includes(OPENPPT_MEDIA_STYLE_CONTEXT_MARKER)) return original ?? base;

  const context = buildOpenPptMediaStyleContext(input);
  if (context.length === 0) return original ?? base;

  const output = cleanText(input.output);
  const outputLine = output ? [`- intended deck asset output: ${output}`] : [];
  return [base, '', ...context, ...outputLine].join('\n');
}
