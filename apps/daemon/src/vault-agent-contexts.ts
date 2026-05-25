import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type VaultAgentContextKind = 'skill-package' | 'prompt-context';

export interface VaultAgentContext {
  slug: string;
  title: string;
  kind: VaultAgentContextKind;
  rootPath?: string;
  packageType?: string;
  summary?: string;
  tags?: string[];
  previewImage?: string;
  manifestPath?: string;
  capabilitiesPath?: string;
  skillPath?: string;
  productPath?: string;
  designSpecPath?: string;
  styleCardPath?: string;
  antiPatternsPath?: string;
  qualityGatesPath?: string;
  designPath?: string;
  openSlideThemePath?: string;
  tokensPath?: string;
  profilePath?: string;
  tokenStylesheet: string | null;
  sourceVisualAssets?: string[];
  references?: string[];
  sourceRootPath?: string;
  sourceSkillPath?: string;
  sourceReadmePath?: string;
  sourceMaterializedPath?: string;
  sourceReferences?: string[];
  sourceAssetsPath?: string;
  sourceAssetEntrypoints?: string[];
  sourceScriptsPath?: string;
  sourceScripts?: string[];
  activationPrompt?: string;
}

export interface VaultAgentContextPrompt {
  body: string;
  warnings: string[];
  filesRead: string[];
}

const MAX_SKILL_CHARS = 18000;
const MAX_REFERENCE_CHARS = 9000;
const MAX_CONTEXT_CHARS = 10000;
const MAX_JSON_CHARS = 8000;
const MAX_SCRIPT_CHARS = 8000;

const SKILL_PACKAGE_TYPES = new Set([
  'component-system',
  'presentation-system',
  'agent-skill-package',
]);

const REFERENCE_PRIORITY = [
  'swiss-layout-lock',
  'layouts-swiss',
  'themes-swiss',
  'image-prompts',
  'checklist',
  'catalog',
  'patterns',
  'layouts',
  'adapters',
  'components',
  'tokens',
];

const VAULT_DESIGNS_SEGMENTS = [
  path.join('apps', 'design-vault', 'data', 'designs'),
  path.join('design-vault', 'data', 'designs'),
];

export function vaultDesignsRoot() {
  const configured =
    process.env.OPENPPT_VAULT_DESIGNS_DIR ||
    process.env.DESIGN_VAULT_DESIGNS_DIR;
  if (configured) return path.resolve(configured);

  const resourceRoots = process.env.OD_RESOURCE_ROOT
    ? VAULT_DESIGNS_SEGMENTS.map((segment) => path.join(process.env.OD_RESOURCE_ROOT!, segment))
    : [];
  const cwdBases = [process.cwd(), path.resolve(process.cwd(), '..'), path.resolve(process.cwd(), '../..')];
  const cwdCandidates = cwdBases.flatMap((base) =>
    VAULT_DESIGNS_SEGMENTS.map((segment) => path.resolve(base, segment)),
  );
  const primaryCwdCandidate = cwdCandidates[0]!;
  const candidates = [...resourceRoots, ...cwdCandidates].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? primaryCwdCandidate;
}

export async function loadVaultAgentContextFromLocalSlug(
  slug: string,
  options: { designsRoot?: string } = {},
): Promise<VaultAgentContext | null> {
  const safeSlug = cleanSlug(slug);
  if (!safeSlug) return null;
  const root = path.join(options.designsRoot ?? vaultDesignsRoot(), safeSlug);
  const meta = await readJson(path.join(root, 'meta.json'));
  return normalizeVaultAgentContext(meta ?? { slug: safeSlug }, { root });
}

export async function normalizeVaultAgentContext(
  raw: unknown,
  options: { root?: string; designsRoot?: string } = {},
): Promise<VaultAgentContext | null> {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, any>;
  const slug = cleanSlug(item.slug);
  if (!slug) return null;

  const root =
    cleanString(options.root) ||
    cleanString(item.local?.root) ||
    cleanString(item.packageManifest?.local?.root) ||
    rootFromKnownPath(item.designPath) ||
    rootFromKnownPath(item.openSlideThemePath) ||
    rootFromKnownPath(item.skillPath) ||
    path.join(options.designsRoot ?? vaultDesignsRoot(), slug);

  const preferLocalRoot = Boolean(options.root || options.designsRoot);
  const rootFirst = (localFile: string, ...values: unknown[]) =>
    preferLocalRoot
      ? firstString(path.join(root, localFile), ...values)
      : firstString(...values, path.join(root, localFile));
  const manifestPath = rootFirst('manifest.json', item.manifestPath, item.packageManifest?.local?.manifestPath);
  const capabilitiesPath = rootFirst(
    'capabilities.json',
    item.capabilitiesPath,
    item.packageManifest?.local?.capabilitiesPath,
  );
  const skillPath = rootFirst(
    path.join('skill', 'SKILL.md'),
    item.skillPath,
    item.packageManifest?.skill?.entrypoint,
  );
  const productPath = rootFirst('PRODUCT.md', item.productPath, item.packageManifest?.local?.productPath);
  const designSpecPath = rootFirst(
    path.join('execution', 'DESIGN.md'),
    item.designSpecPath,
    item.packageManifest?.local?.designSpecPath,
  );
  const styleCardPath = rootFirst('STYLE_CARD.html', item.styleCardPath, item.packageManifest?.local?.styleCardPath);
  const antiPatternsPath = rootFirst('anti-patterns.json', item.antiPatternsPath, item.packageManifest?.local?.antiPatternsPath);
  const qualityGatesPath = rootFirst('quality-gates.json', item.qualityGatesPath, item.packageManifest?.local?.qualityGatesPath);
  const designPath = rootFirst('design.md', item.designPath);
  const openSlideThemePath = rootFirst('open-slide-theme.md', item.openSlideThemePath);
  const tokensPath = rootFirst('tokens.json', item.tokensPath);
  const profilePath = rootFirst('profile.json', item.profilePath);
  const tokenStylesheet = await readTokenStylesheet(root);
  const sourceVisualAssets = await collectSourceVisualAssets(root);
  const sourceRootPath = await firstExistingDirectory([
    path.join(root, 'skill', 'source'),
    cleanString(item.sourceRootPath),
    cleanString(item.packageManifest?.skill?.sourceRootPath),
    cleanString(item.packageManifest?.skill?.sourceRoot),
    path.join(root, 'vendor', 'source'),
  ]);
  const sourceSkillPath = sourceRootPath ? path.join(sourceRootPath, 'SKILL.md') : '';
  const sourceReadmePath = sourceRootPath ? await firstExistingFile([
    path.join(sourceRootPath, 'README.md'),
    path.join(sourceRootPath, 'README.en.md'),
  ]) : '';
  const sourceMaterializedPath = sourceRootPath ? await firstExistingFile([
    path.join(sourceRootPath, 'materialized.json'),
  ]) : '';
  const sourceAssetsPath = sourceRootPath ? await firstExistingDirectory([
    path.join(sourceRootPath, 'assets'),
  ]) : '';
  const sourceScriptsPath = sourceRootPath ? await firstExistingDirectory([
    path.join(sourceRootPath, 'scripts'),
  ]) : '';

  const manifest = await readJson(manifestPath);
  const packageType = cleanString(
    item.packageType ||
      item.packageManifest?.packageType ||
      manifest?.packageType,
  );
  const secondaryTypes = normalizeStringArray(
    item.secondaryTypes ||
      item.packageManifest?.secondaryTypes ||
      manifest?.secondaryTypes,
  );
  const hasSkill = await isFile(skillPath);
  const kind: VaultAgentContextKind =
    hasSkill ||
    SKILL_PACKAGE_TYPES.has(packageType) ||
    secondaryTypes.some((value) => SKILL_PACKAGE_TYPES.has(value))
      ? 'skill-package'
      : 'prompt-context';

  const references = await collectReferences({
    rawReferences: item.references || item.packageManifest?.skill?.references || manifest?.skill?.references,
    root,
    skillPath,
  });
  const sourceReferences = sourceRootPath
    ? await collectReferences({
        rawReferences: [],
        root,
        referenceDirs: [path.join(sourceRootPath, 'references')],
      })
    : [];
  const sourceAssetEntrypoints = sourceAssetsPath
    ? await collectDirectoryFiles(sourceAssetsPath, /\.(html|css|js)$/i)
    : [];
  const sourceScripts = sourceScriptsPath
    ? await collectDirectoryFiles(sourceScriptsPath, /\.(mjs|js|ts)$/i)
    : [];
  const previewImage = firstString(
    item.previewImage,
    findAssetPath(item.assets),
    await findProjectDemoImage(root),
  );

  const context: VaultAgentContext = {
    slug,
    title: cleanString(item.title) || cleanString(item.name) || cleanString(item.packageManifest?.name) || slug,
    kind,
    rootPath: root,
    tokenStylesheet,
  };
  assignString(context, 'packageType', packageType);
  assignString(context, 'summary', cleanString(item.summary) || cleanString(manifest?.summary));
  const tags = normalizeStringArray(item.tags).concat(normalizeStringArray(manifest?.capabilities));
  if (tags.length > 0) context.tags = dedupe(tags).slice(0, 20);
  assignString(context, 'previewImage', previewImage);
  assignString(context, 'manifestPath', manifestPath);
  assignString(context, 'capabilitiesPath', capabilitiesPath);
  assignString(context, 'skillPath', skillPath);
  assignString(context, 'productPath', productPath);
  assignString(context, 'designSpecPath', designSpecPath);
  assignString(context, 'styleCardPath', styleCardPath);
  assignString(context, 'antiPatternsPath', antiPatternsPath);
  assignString(context, 'qualityGatesPath', qualityGatesPath);
  assignString(context, 'designPath', designPath);
  assignString(context, 'openSlideThemePath', openSlideThemePath);
  assignString(context, 'tokensPath', tokensPath);
  assignString(context, 'profilePath', profilePath);
  if (sourceVisualAssets.length > 0) context.sourceVisualAssets = sourceVisualAssets;
  if (references.length > 0) context.references = references;
  assignString(context, 'sourceRootPath', sourceRootPath);
  assignString(context, 'sourceSkillPath', sourceSkillPath);
  assignString(context, 'sourceReadmePath', sourceReadmePath);
  assignString(context, 'sourceMaterializedPath', sourceMaterializedPath);
  if (sourceReferences.length > 0) context.sourceReferences = sourceReferences;
  assignString(context, 'sourceAssetsPath', sourceAssetsPath);
  if (sourceAssetEntrypoints.length > 0) context.sourceAssetEntrypoints = sourceAssetEntrypoints;
  assignString(context, 'sourceScriptsPath', sourceScriptsPath);
  if (sourceScripts.length > 0) context.sourceScripts = sourceScripts;
  assignString(
    context,
    'activationPrompt',
    rewriteEmbeddedVaultPaths(
      cleanString(item.activationPrompt) ||
      cleanString(item.packageManifest?.skill?.referencePrompt) ||
      cleanString(manifest?.skill?.referencePrompt) ||
      defaultActivationPrompt(slug, kind, packageType),
      slug,
      root,
    ),
  );
  return context;
}

export async function buildVaultAgentContextPrompt(
  context: VaultAgentContext | null | undefined,
): Promise<VaultAgentContextPrompt | null> {
  if (!context?.slug) return null;
  const warnings: string[] = [];
  const filesRead: string[] = [];
  const sections: string[] = [
    '## Active Design Vault agent context',
    '',
    'This is the authoritative design system context selected by the user.',
    'Do not imitate the template name superficially. Read the Design Vault context files and follow their layout, typography, visual hierarchy, constraints, and checklist.',
    'If a file below is missing or unreadable, say so explicitly and do not claim that its rules were applied.',
    '',
    `- slug: ${context.slug}`,
    `- title: ${context.title}`,
    `- kind: ${context.kind}`,
    context.packageType ? `- packageType: ${context.packageType}` : '',
    context.summary ? `- summary: ${context.summary}` : '',
    context.activationPrompt ? `- activationPrompt: ${context.activationPrompt}` : '',
  ].filter((value): value is string => Boolean(value));

  appendSourceVisualAssetsSection(sections, context);

  if (context.kind === 'skill-package') {
    sections.push(
      '',
      '### Skill-package rule',
      'Treat this as an executable design skill. Before generating or modifying slides, follow SKILL.md first, then capabilities.json and references. Match the user task to concrete capabilities, patterns, layout primitives, adapters, and checklist gates.',
    );
    await appendFileSection(sections, warnings, filesRead, 'manifest.json', context.manifestPath, MAX_JSON_CHARS, 'json', false, context);
    await appendFileSection(sections, warnings, filesRead, 'capabilities.json', context.capabilitiesPath, MAX_JSON_CHARS, 'json', false, context);
    await appendFileSection(sections, warnings, filesRead, 'skill/SKILL.md', context.skillPath, MAX_SKILL_CHARS, 'markdown', false, context);
    for (const ref of prioritizeReferences(context.references ?? [])) {
      await appendFileSection(sections, warnings, filesRead, `reference/${path.basename(ref)}`, ref, MAX_REFERENCE_CHARS, 'markdown', false, context);
    }
    await appendFileSection(sections, warnings, filesRead, 'PRODUCT.md', context.productPath, MAX_CONTEXT_CHARS, 'markdown', true, context);
    await appendFileSection(sections, warnings, filesRead, 'execution/DESIGN.md', context.designSpecPath, MAX_CONTEXT_CHARS, 'markdown', true, context);
    await appendFileSection(sections, warnings, filesRead, 'STYLE_CARD.html', context.styleCardPath, MAX_CONTEXT_CHARS, 'html', true, context);
    await appendFileSection(sections, warnings, filesRead, 'anti-patterns.json', context.antiPatternsPath, MAX_JSON_CHARS, 'json', true, context);
    await appendFileSection(sections, warnings, filesRead, 'quality-gates.json', context.qualityGatesPath, MAX_JSON_CHARS, 'json', true, context);
    await appendSourcePackageSections(sections, warnings, filesRead, context);
    await appendFileSection(sections, warnings, filesRead, 'open-slide-theme.md', context.openSlideThemePath, MAX_CONTEXT_CHARS, 'markdown', true, context);
    await appendFileSection(sections, warnings, filesRead, 'design.md', context.designPath, MAX_CONTEXT_CHARS, 'markdown', true, context);
  } else {
    sections.push(
      '',
      '### Prompt-context rule',
      'Treat this as authoritative DESIGN.md / prompt context. Follow palette, typography, density, layout grammar, motion language, suitable/unsuitable cases, avoid rules, and checklist before writing any slide source.',
      'For SFA decks, the execution context and style card are not optional references: use them as the concrete fidelity target, then audit against anti-patterns and quality gates before finalizing.',
    );
    await appendFileSection(sections, warnings, filesRead, 'PRODUCT.md', context.productPath, MAX_CONTEXT_CHARS, 'markdown', true, context);
    await appendFileSection(sections, warnings, filesRead, 'execution/DESIGN.md', context.designSpecPath, MAX_CONTEXT_CHARS, 'markdown', true, context);
    await appendFileSection(sections, warnings, filesRead, 'STYLE_CARD.html', context.styleCardPath, MAX_CONTEXT_CHARS, 'html', true, context);
    await appendFileSection(sections, warnings, filesRead, 'anti-patterns.json', context.antiPatternsPath, MAX_JSON_CHARS, 'json', true, context);
    await appendFileSection(sections, warnings, filesRead, 'quality-gates.json', context.qualityGatesPath, MAX_JSON_CHARS, 'json', true, context);
    await appendFileSection(sections, warnings, filesRead, 'capabilities.json', context.capabilitiesPath, MAX_JSON_CHARS, 'json', true, context);
    await appendFileSection(sections, warnings, filesRead, 'design.md', context.designPath, MAX_CONTEXT_CHARS, 'markdown', false, context);
    await appendFileSection(sections, warnings, filesRead, 'open-slide-theme.md', context.openSlideThemePath, MAX_CONTEXT_CHARS, 'markdown', false, context);
    await appendFileSection(sections, warnings, filesRead, 'tokens.json', context.tokensPath, MAX_JSON_CHARS, 'json', true, context);
    await appendFileSection(sections, warnings, filesRead, 'profile.json', context.profilePath, MAX_JSON_CHARS, 'json', true, context);
  }

  if (warnings.length > 0) {
    sections.push('', '### Design Vault context warnings');
    for (const warning of warnings) sections.push(`- ${warning}`);
  }

  return { body: sections.join('\n'), warnings, filesRead };
}

export async function materializeVaultAgentContext(
  context: VaultAgentContext,
  options: { skillsDir: string; designSystemsDir: string },
): Promise<{ skillId?: string; designSystemId?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const slug = cleanSlug(context.slug);
  if (!slug) return { warnings: ['invalid Design Vault slug; nothing was materialized'] };

  if (context.kind === 'skill-package') {
    const sourceDir = context.skillPath ? path.dirname(context.skillPath) : '';
    if (!sourceDir || !(await isDirectory(sourceDir))) {
      return { warnings: [`skill package ${slug} has no readable skill directory`] };
    }
    const target = path.join(options.skillsDir, `dv-${slug}`);
    await fs.mkdir(target, { recursive: true });
    await copyIfExists(path.join(sourceDir, 'SKILL.md'), path.join(target, 'SKILL.md'), context, target);
    await copyDirIfExists(path.join(sourceDir, 'references'), path.join(target, 'references'));
    await rewriteCopiedVaultTextFiles(path.join(target, 'references'), context, target);
    await copyDirIfExists(path.join(sourceDir, 'assets'), path.join(target, 'assets'));
    if (context.rootPath) {
      await copyDirIfExists(path.join(context.rootPath, 'references'), path.join(target, 'references'));
      await rewriteCopiedVaultTextFiles(path.join(target, 'references'), context, target);
      await copyDirIfExists(path.join(context.rootPath, 'assets'), path.join(target, 'assets'));
      await copyDirIfExists(path.join(context.rootPath, 'scripts'), path.join(target, 'scripts'));
      await rewriteCopiedVaultTextFiles(path.join(target, 'scripts'), context, target);
    }
    await copyDirIfExists(path.join(sourceDir, 'source'), path.join(target, 'source'));
    await rewriteCopiedVaultTextFiles(path.join(target, 'source'), context, target);
    await copyVaultContextFileSet(context, target);
    const demoRoot = context.previewImage && !path.isAbsolute(context.previewImage)
      ? path.resolve(path.dirname(context.skillPath ?? sourceDir), '..', context.previewImage)
      : '';
    if (demoRoot) await copyIfExists(demoRoot, path.join(target, 'assets', 'project-demo' + path.extname(demoRoot)));
    return { skillId: `dv-${slug}`, warnings };
  }

  const prompt = await buildVaultAgentContextPrompt(context);
  const target = path.join(options.designSystemsDir, `dv-${slug}`);
  await fs.mkdir(target, { recursive: true });
  const designBody = [
    `# ${context.title}`,
    '',
    '> Category: Design Vault',
    '> Surface: web',
    '',
    prompt?.body ?? `Design Vault prompt context for ${context.slug}.`,
  ].join('\n');
  await fs.writeFile(path.join(target, 'DESIGN.md'), `${designBody.trim()}\n`, 'utf8');
  return { designSystemId: `dv-${slug}`, warnings };
}

export function localPreviewUrlForVaultContext(context: VaultAgentContext): string | undefined {
  if (!context.previewImage) return undefined;
  if (/^https?:\/\//i.test(context.previewImage) || context.previewImage.startsWith('/api/')) {
    return context.previewImage;
  }
  return `/api/vault/designs/${encodeURIComponent(context.slug)}/asset?path=${encodeURIComponent(context.previewImage)}`;
}

export async function readTokenStylesheet(rootPath: string): Promise<string | null> {
  const cardHtml = await fs.readFile(
    path.join(rootPath, 'previews', 'card.html'),
    'utf8',
  ).catch(() => '');
  if (!cardHtml) return null;
  const styleBlocks = cardHtml.match(/<style\b[^>]*>\s*:root[\s\S]*?<\/style>/gi) ?? [];
  return (
    styleBlocks.find((block) =>
      /--dv-(?:bg|bg-deep|text-primary|accent|radius-card|motion-reveal)\s*:/.test(block),
    ) ??
    styleBlocks[0] ??
    null
  );
}

async function collectSourceVisualAssets(root: string): Promise<string[]> {
  const assetsRoot = path.join(root, 'assets');
  if (!(await isDirectory(assetsRoot))) return [];
  const files = await collectDirectoryFiles(
    assetsRoot,
    /\.(?:png|jpe?g|webp|gif|avif|svg)$/i,
  );
  const priority = (file: string) => {
    const rel = path.relative(assetsRoot, file).replace(/\\/g, '/').toLowerCase();
    if (/^visual-journey\/load-viewport\./.test(rel)) return 0;
    if (/^visual-journey\//.test(rel)) return 1;
    if (/^hero-image-/.test(rel)) return 2;
    if (/^dom-image-/.test(rel)) return 3;
    if (/^logo-/.test(rel)) return 4;
    if (/^css-image-/.test(rel)) return 5;
    if (/^inline-icon-/.test(rel)) return 7;
    return 6;
  };
  return files
    .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
    .slice(0, 16);
}

function appendSourceVisualAssetsSection(sections: string[], context: VaultAgentContext) {
  const assets = context.sourceVisualAssets ?? [];
  if (assets.length === 0) return;
  sections.push(
    '',
    '### Localized source visual assets',
    'These are concrete source screenshots/images from the selected Vault template. For SFA decks, inspect these before layout work. If the source style is media-led, copy at least one representative source asset into `slides/<slideId>/assets/`, import it, and use it on the source-recognition cover or major visual pages. Do not reduce the template to palette, font, and thin lines.',
  );
  for (const asset of assets) {
    const rel = context.rootPath ? path.relative(context.rootPath, asset).replace(/\\/g, '/') : path.basename(asset);
    sections.push(`- ${rel}: ${asset}`);
  }
}

function defaultActivationPrompt(slug: string, kind: VaultAgentContextKind, packageType: string) {
  if (kind === 'skill-package') {
    return `Use the Design Vault skill package "${slug}". Read SKILL.md, capabilities.json, and references before generating.`;
  }
  return `Use the Design Vault prompt context "${slug}". Read DESIGN.md/open-slide-theme/tokens/profile before generating.`;
}

async function appendFileSection(
  sections: string[],
  warnings: string[],
  filesRead: string[],
  label: string,
  filePath: string | undefined,
  maxChars: number,
  lang: string,
  optional = false,
  context?: VaultAgentContext,
) {
  if (!filePath) {
    if (!optional) warnings.push(`${label} path is missing`);
    return;
  }
  const result = await readFileSnippet(filePath, maxChars, context);
  if (!result) {
    if (!optional) warnings.push(`${label} is not readable at ${filePath}`);
    return;
  }
  filesRead.push(filePath);
  sections.push('', `### ${label}`, `Path: ${filePath}`, '', `\`\`\`${lang}`, result, '```');
}

async function appendSourcePackageSections(
  sections: string[],
  warnings: string[],
  filesRead: string[],
  context: VaultAgentContext,
) {
  if (!context.sourceRootPath && !context.sourceSkillPath) return;

  sections.push(
    '',
    '### Active upstream source package',
    'The Design Vault wrapper above is routing context. The concrete source-of-truth skill package is materialized under `skill/source/`; use that upstream SKILL.md, references, templates, assets, and validators for source-faithful generation.',
  );
  const pointers = [
    context.sourceRootPath ? `- source root: ${context.sourceRootPath}` : null,
    context.sourceSkillPath ? `- upstream SKILL.md: ${context.sourceSkillPath}` : null,
    context.sourceAssetsPath ? `- upstream assets/templates: ${context.sourceAssetsPath}` : null,
    context.sourceScriptsPath ? `- upstream scripts/validators: ${context.sourceScriptsPath}` : null,
  ].filter((value): value is string => Boolean(value));
  if (pointers.length > 0) sections.push('', ...pointers);
  if (context.sourceAssetEntrypoints?.length) {
    sections.push(
      '',
      'Source asset entrypoints to read before layout work:',
      ...context.sourceAssetEntrypoints
        .map((file) => `- ${file}`)
        .slice(0, 12),
    );
  }
  if (context.sourceScripts?.length) {
    sections.push(
      '',
      'Source validation scripts to run when applicable:',
      ...context.sourceScripts.map((file) => `- ${file}`).slice(0, 8),
    );
  }

  await appendFileSection(sections, warnings, filesRead, 'skill/source/materialized.json', context.sourceMaterializedPath, MAX_JSON_CHARS, 'json', true, context);
  await appendFileSection(sections, warnings, filesRead, 'skill/source/SKILL.md', context.sourceSkillPath, MAX_SKILL_CHARS, 'markdown', false, context);
  await appendFileSection(sections, warnings, filesRead, 'skill/source/README.md', context.sourceReadmePath, MAX_CONTEXT_CHARS, 'markdown', true, context);
  for (const ref of prioritizeReferences(context.sourceReferences ?? [])) {
    await appendFileSection(
      sections,
      warnings,
      filesRead,
      `source/reference/${path.basename(ref)}`,
      ref,
      MAX_REFERENCE_CHARS,
      'markdown',
      false,
      context,
    );
  }
  for (const script of prioritizeReferences(context.sourceScripts ?? []).slice(0, 4)) {
    await appendFileSection(
      sections,
      warnings,
      filesRead,
      `source/script/${path.basename(script)}`,
      script,
      MAX_SCRIPT_CHARS,
      'javascript',
      true,
      context,
    );
  }
}

async function readFileSnippet(filePath: string, maxChars: number, context?: VaultAgentContext) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const raw = await fs.readFile(filePath, 'utf8');
    const rewritten = context ? rewriteEmbeddedVaultPaths(raw, context.slug, context.rootPath || path.dirname(filePath)) : raw;
    const safe = rewritten.replace(/```/g, '`\u200b`\u200b`');
    if (safe.length <= maxChars) return safe.trim();
    return `${safe.slice(0, maxChars).trim()}\n... (truncated ${safe.length - maxChars} chars)`;
  } catch {
    return null;
  }
}

async function collectReferences({
  rawReferences,
  root,
  skillPath,
  referenceDirs,
}: {
  rawReferences: unknown;
  root: string;
  skillPath?: string;
  referenceDirs?: string[];
}) {
  const refs: string[] = [];
  for (const raw of normalizeStringArray(rawReferences)) {
    const resolved = resolveVaultReferencePath(raw, root);
    if (!resolved) continue;
    if (await isDirectory(resolved)) {
      if (path.basename(resolved) === 'references') {
        refs.push(...(await collectDirectoryFiles(resolved, /\.md$/i)));
      }
      continue;
    }
    if (/\.(md|markdown|txt)$/i.test(resolved)) refs.push(resolved);
  }

  const dirs = [
    ...(skillPath ? [path.join(path.dirname(skillPath), 'references')] : []),
    ...(Array.isArray(referenceDirs) ? referenceDirs : []),
  ];
  for (const referenceDir of dirs) {
    refs.push(...(await collectDirectoryFiles(referenceDir, /\.md$/i)));
  }

  return dedupe(
    refs
      .map((ref) => resolveVaultReferencePath(ref, root))
      .filter(Boolean),
  );
}

function resolveVaultReferencePath(ref: string, root: string) {
  const clean = cleanString(ref);
  if (!clean) return '';
  if (!path.isAbsolute(clean)) return path.join(root, clean);
  if (isPathWithin(root, clean)) return clean;
  const marker = `${path.sep}design-vault${path.sep}data${path.sep}designs${path.sep}`;
  const markerIndex = clean.indexOf(marker);
  if (markerIndex === -1) return clean;
  const afterMarker = clean.slice(markerIndex + marker.length);
  const parts = afterMarker.split(path.sep).filter(Boolean);
  if (parts.length <= 1) return clean;
  return path.join(root, ...parts.slice(1));
}

function rewriteEmbeddedVaultPaths(
  value: string,
  slug: string,
  root: string,
  sourceRoot?: string,
  upstreamSourceRoot?: string,
  upstreamSourceTarget?: string,
) {
  const safeSlug = cleanSlug(slug);
  if (!safeSlug || !root) return value;
  const normalizedRoot = path.resolve(root);
  const slashSlug = safeSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let rewritten = value;
  const normalizedUpstreamSourceTarget = upstreamSourceTarget ? path.resolve(upstreamSourceTarget) : '';
  if (normalizedUpstreamSourceTarget) {
    const sourcePattern = new RegExp(
      "(?:[A-Za-z]:)?/[^\\s\"'`<>)]*/design-vault/data/designs/" + slashSlug + '/skill/source',
      'g',
    );
    rewritten = rewritten.replace(sourcePattern, normalizedUpstreamSourceTarget);
  }
  const normalizedUpstreamSourceRoot = upstreamSourceRoot ? path.resolve(upstreamSourceRoot) : '';
  if (
    normalizedUpstreamSourceRoot &&
    normalizedUpstreamSourceTarget &&
    normalizedUpstreamSourceRoot !== normalizedUpstreamSourceTarget
  ) {
    rewritten = rewritten.split(normalizedUpstreamSourceRoot).join(normalizedUpstreamSourceTarget);
  }
  const pattern = new RegExp(
    "(?:[A-Za-z]:)?/[^\\s\"'`<>)]*/design-vault/data/designs/" + slashSlug,
    'g',
  );
  rewritten = rewritten.replace(pattern, normalizedRoot);
  const normalizedSourceRoot = sourceRoot ? path.resolve(sourceRoot) : '';
  if (normalizedSourceRoot && normalizedSourceRoot !== normalizedRoot) {
    rewritten = rewritten.split(normalizedSourceRoot).join(normalizedRoot);
  }
  return rewritten;
}

function isPathWithin(base: string, target: string) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function prioritizeReferences(references: string[]) {
  return [...references].sort((a, b) => {
    const aa = referenceScore(a);
    const bb = referenceScore(b);
    if (aa !== bb) return aa - bb;
    return a.localeCompare(b);
  }).slice(0, 10);
}

async function collectDirectoryFiles(dir: string, pattern: RegExp) {
  const out: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await collectDirectoryFiles(file, pattern)));
        continue;
      }
      if (entry.isFile() && pattern.test(entry.name)) out.push(file);
    }
  } catch {
    // Directory is optional; callers decide whether an empty list is fatal.
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function referenceScore(filePath: string) {
  const base = path.basename(filePath).replace(/\.[^.]+$/, '').toLowerCase();
  const index = REFERENCE_PRIORITY.findIndex((name) => base.includes(name));
  return index === -1 ? 99 : index;
}

function findAssetPath(assets: unknown): string {
  if (!Array.isArray(assets)) return '';
  const found = assets.find((asset) => {
    if (!asset || typeof asset !== 'object') return false;
    const item = asset as Record<string, unknown>;
    const kind = cleanString(item.kind).toLowerCase();
    const assetPath = cleanString(item.path);
    return assetPath && (kind === 'image' || kind === 'logo' || kind === 'svg' || /\.(png|jpe?g|webp|svg)$/i.test(assetPath));
  }) as Record<string, unknown> | undefined;
  return cleanString(found?.path);
}

async function findProjectDemoImage(root: string) {
  const demoDir = path.join(root, 'assets', 'project-demos');
  try {
    const entries = await fs.readdir(demoDir, { withFileTypes: true });
    const file = entries
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|svg)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()[0];
    return file ? path.join('assets', 'project-demos', file) : '';
  } catch {
    return '';
  }
}

async function copyVaultContextFileSet(context: VaultAgentContext, target: string) {
  await copyIfExists(context.manifestPath ?? '', path.join(target, 'manifest.json'), context, target);
  await copyIfExists(context.capabilitiesPath ?? '', path.join(target, 'capabilities.json'), context, target);
  await copyIfExists(context.productPath ?? '', path.join(target, 'PRODUCT.md'), context, target);
  await copyIfExists(context.designSpecPath ?? '', path.join(target, 'execution', 'DESIGN.md'), context, target);
  await copyIfExists(context.styleCardPath ?? '', path.join(target, 'STYLE_CARD.html'), context, target);
  await copyIfExists(context.antiPatternsPath ?? '', path.join(target, 'anti-patterns.json'), context, target);
  await copyIfExists(context.qualityGatesPath ?? '', path.join(target, 'quality-gates.json'), context, target);
  await copyIfExists(context.designPath ?? '', path.join(target, 'design.md'), context, target);
  await copyIfExists(context.openSlideThemePath ?? '', path.join(target, 'open-slide-theme.md'), context, target);
  await copyIfExists(context.tokensPath ?? '', path.join(target, 'tokens.json'), context, target);
  await copyIfExists(context.profilePath ?? '', path.join(target, 'profile.json'), context, target);
}

async function copyIfExists(source: string, target: string, context?: VaultAgentContext, rewriteRoot?: string) {
  if (!(await isFile(source))) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (context && /\.(md|json|txt)$/i.test(source)) {
    const raw = await fs.readFile(source, 'utf8');
    await fs.writeFile(
      target,
      rewriteEmbeddedVaultPaths(
        raw,
        context.slug,
        rewriteRoot || context.rootPath || path.dirname(source),
        context.rootPath,
        context.sourceRootPath,
        rewriteRoot ? path.join(rewriteRoot, 'source') : undefined,
      ),
      'utf8',
    );
    return;
  }
  await fs.copyFile(source, target);
}

async function copyDirIfExists(source: string, target: string) {
  if (!(await isDirectory(source))) return;
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
}

async function rewriteCopiedVaultTextFiles(root: string, context: VaultAgentContext, rewriteRoot?: string) {
  if (!(await isDirectory(root))) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await rewriteCopiedVaultTextFiles(target, context, rewriteRoot);
      return;
    }
    if (!entry.isFile() || !/\.(md|json|txt)$/i.test(entry.name)) return;
    const raw = await fs.readFile(target, 'utf8');
    await fs.writeFile(
      target,
      rewriteEmbeddedVaultPaths(
        raw,
        context.slug,
        rewriteRoot || context.rootPath || path.dirname(target),
        context.rootPath,
        context.sourceRootPath,
        rewriteRoot ? path.join(rewriteRoot, 'source') : undefined,
      ),
      'utf8',
    );
  }));
}

async function firstExistingDirectory(candidates: string[]) {
  for (const candidate of candidates.map(cleanString).filter(Boolean)) {
    if (await isDirectory(candidate)) return candidate;
  }
  return '';
}

async function firstExistingFile(candidates: string[]) {
  for (const candidate of candidates.map(cleanString).filter(Boolean)) {
    if (await isFile(candidate)) return candidate;
  }
  return '';
}

async function readJson(filePath: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

async function isFile(filePath: string) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string) {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function rootFromKnownPath(value: unknown) {
  const raw = cleanString(value);
  return raw ? path.dirname(raw) : '';
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const clean = cleanString(value);
    if (clean) return clean;
  }
  return '';
}

function cleanString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanSlug(value: unknown) {
  const slug = cleanString(value);
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : '';
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter(Boolean);
}

function dedupe(values: string[]) {
  return Array.from(new Set(values));
}

function assignString<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
) {
  const clean = cleanString(value);
  if (clean) target[key] = clean as T[K];
}
