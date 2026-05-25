// @ts-nocheck
import express from 'express';
import multer from 'multer';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { composeSystemPrompt } from './prompts/system.js';
import { createCommandInvocation } from '@open-design/platform';
import {
  buildLiveArtifactsMcpServersForAgent,
  checkPromptArgvBudget,
  checkWindowsCmdShimCommandLineBudget,
  checkWindowsDirectExeCommandLineBudget,
  detectAgents,
  getAgentDef,
  isKnownModel,
  normalizeAgentModelChoice,
  resolveAgentBin,
  sanitizeCustomModel,
  spawnEnvForAgent,
} from './agents.js';
import { findSkillById, listSkills } from './skills.js';
import { validateLinkedDirs } from './linked-dirs.js';
import { listDesignSystems, readDesignSystem } from './design-systems.js';
import { attachAcpSession } from './acp.js';
import { attachPiRpcSession } from './pi-rpc.js';
import { createClaudeStreamHandler } from './claude-stream.js';
import { loadCritiqueConfigFromEnv } from './critique/config.js';
import { reconcileStaleRuns } from './critique/persistence.js';
import { runOrchestrator } from './critique/orchestrator.js';
import { createCopilotStreamHandler } from './copilot-stream.js';
import { createJsonEventStreamHandler } from './json-event-stream.js';
import { subscribe as subscribeFileEvents } from './project-watchers.js';
import { renderDesignSystemPreview } from './design-system-preview.js';
import { renderDesignSystemShowcase } from './design-system-showcase.js';
import { createChatRunService } from './runs.js';
import { importClaudeDesignZip } from './claude-design-import.js';
import { listPromptTemplates, readPromptTemplate } from './prompt-templates.js';
import { buildDocumentPreview } from './document-preview.js';
import { lintArtifact, renderFindingsForAgent } from './lint-artifact.js';
import { buildOpenPptExportArtifacts } from './openppt-export.js';
import { loadCraftSections } from './craft.js';
import { stageActiveSkill } from './cwd-aliases.js';
import { generateMedia } from './media.js';
import { enhanceOpenPptMediaPrompt } from './openppt-media-prompts.js';
import { getCodexImageProxyStatus, handleCodexImageGenerationsRequest } from './codex-image-proxy.js';
import {
  buildVaultAgentContextPrompt,
  loadVaultAgentContextFromLocalSlug,
  localPreviewUrlForVaultContext,
  materializeVaultAgentContext,
  normalizeVaultAgentContext,
  vaultDesignsRoot,
} from './vault-agent-contexts.js';
import {
  AUDIO_DURATIONS_SEC,
  AUDIO_MODELS_BY_KIND,
  IMAGE_MODELS,
  MEDIA_ASPECTS,
  MEDIA_PROVIDERS,
  VIDEO_LENGTHS_SEC,
  VIDEO_MODELS,
} from './media-models.js';
import { readMaskedConfig, writeConfig } from './media-config.js';
import { readAppConfig, writeAppConfig } from './app-config.js';
import {
  buildProjectArchive,
  buildBatchArchive,
  decodeMultipartFilename,
  deleteProjectFile,
  ensureProject,
  listFiles,
  mimeFor,
  projectDir,
  readProjectFile,
  removeProjectDir,
  sanitizeName,
  searchProjectFiles,
  writeProjectFile,
} from './projects.js';
import { validateArtifactManifestInput } from './artifact-manifest.js';
import { readCurrentAppVersionInfo } from './app-version.js';
import { checkForAppUpdates } from './update-check.js';
import {
  deleteConversation,
  deletePreviewComment,
  deleteProject as dbDeleteProject,
  deleteTemplate,
  getConversation,
  getDeployment,
  getDeploymentById,
  getProject,
  getTemplate,
  insertConversation,
  insertProject,
  insertTemplate,
  listProjectsAwaitingInput,
  listConversations,
  listDeployments,
  listLatestProjectRunStatuses,
  listMessages,
  listPreviewComments,
  listProjects,
  listSlideFeedback,
  listTabs,
  listTemplates,
  openDatabase,
  setTabs,
  updateConversation,
  updatePreviewCommentStatus,
  updateProject,
  updateSlideFeedbackStatus,
  upsertDeployment,
  upsertMessage,
  upsertPreviewComment,
  insertSlideFeedback,
  deleteSlideFeedback,
} from './db.js';
import {
  createLiveArtifact,
  deleteLiveArtifact,
  ensureLiveArtifactPreview,
  getLiveArtifact,
  LiveArtifactRefreshLockError,
  LiveArtifactStoreValidationError,
  listLiveArtifacts,
  listLiveArtifactRefreshLogEntries,
  readLiveArtifactCode,
  recoverStaleLiveArtifactRefreshes,
  updateLiveArtifact,
} from './live-artifacts/store.js';
import { LiveArtifactRefreshUnavailableError, refreshLiveArtifact } from './live-artifacts/refresh-service.js';
import { LiveArtifactRefreshAbortError } from './live-artifacts/refresh.js';
import { registerConnectorRoutes } from './connectors/routes.js';
import { configureConnectorCredentialStore, ConnectorServiceError, deleteConnectorCredentialsByProvider, FileConnectorCredentialStore } from './connectors/service.js';
import { composioConnectorProvider } from './connectors/composio.js';
import { configureComposioConfigStore, readComposioConfig, readPublicComposioConfig, writeComposioConfig } from './connectors/composio-config.js';
import { CHAT_TOOL_ENDPOINTS, CHAT_TOOL_OPERATIONS, toolTokenRegistry } from './tool-tokens.js';
import {
  buildDeployFileSet,
  checkDeploymentUrl,
  DeployError,
  deployToVercel,
  prepareDeployPreflight,
  publicDeployConfig,
  readVercelConfig,
  VERCEL_PROVIDER_ID,
  writeVercelConfig,
} from './deploy.js';

/** @typedef {import('@open-design/contracts').ApiErrorCode} ApiErrorCode */
/** @typedef {import('@open-design/contracts').ApiError} ApiError */
/** @typedef {import('@open-design/contracts').ApiErrorResponse} ApiErrorResponse */
/** @typedef {import('@open-design/contracts').ChatRequest} ChatRequest */
/** @typedef {import('@open-design/contracts').ChatSseEvent} ChatSseEvent */
/** @typedef {import('@open-design/contracts').ProxyStreamRequest} ProxyStreamRequest */
/** @typedef {import('@open-design/contracts').ProxySseEvent} ProxySseEvent */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
export function resolveProjectRoot(moduleDir: string): string {
  const base = path.basename(moduleDir);
  const daemonDir =
    base === 'dist' || base === 'src' ? path.dirname(moduleDir) : moduleDir;
  return path.resolve(daemonDir, '../..');
}

export function resolveDaemonCliPath(): string {
  const packageJsonPath = require.resolve('@open-design/daemon/package.json');
  return path.join(path.dirname(packageJsonPath), 'dist', 'cli.js');
}

const PROJECT_ROOT = resolveProjectRoot(__dirname);
const RESOURCE_ROOT_ENV = 'OD_RESOURCE_ROOT';

export function normalizeCommentAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const filePath = cleanString(raw.filePath);
      const elementId = cleanString(raw.elementId);
      const selector = cleanString(raw.selector);
      const label = cleanString(raw.label);
      const comment = cleanString(raw.comment);
      if (!filePath || !elementId || !selector || !comment) return null;
      return {
        id: cleanString(raw.id) || `comment-${index + 1}`,
        order: Number.isFinite(raw.order)
          ? Math.max(1, Math.round(raw.order))
          : index + 1,
        filePath,
        elementId,
        selector,
        label,
        comment,
        currentText: compactString(raw.currentText, 160),
        pagePosition: normalizeAttachmentPosition(raw.pagePosition),
        htmlHint: compactString(raw.htmlHint, 180),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

export function renderCommentAttachmentHint(commentAttachments) {
  if (!commentAttachments.length) return '';
  const lines = [
    '',
    '',
    '<attached-preview-comments>',
    'Scope: edit the target element by default. Use the smallest necessary parent wrapper only if the target cannot satisfy the comment. Preserve stable ids and unrelated siblings.',
  ];
  for (const item of commentAttachments) {
    lines.push(
      '',
      `${item.order}. ${item.elementId}`,
      `file: ${item.filePath}`,
      `selector: ${item.selector}`,
      `label: ${item.label || '(unlabeled)'}`,
      `position: ${formatAttachmentPosition(item.pagePosition)}`,
      `currentText: ${item.currentText || '(empty)'}`,
      `htmlHint: ${item.htmlHint || '(none)'}`,
      `comment: ${item.comment}`,
    );
  }
  lines.push('</attached-preview-comments>');
  return lines.join('\n');
}

export function normalizeSlideFeedbackAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const kind = cleanString(raw.kind) || 'comment';
      const slideId = cleanString(raw.slideId);
      const note = cleanString(raw.note);
      if (!slideId || !note) return null;
      return {
        id: cleanString(raw.id) || `slide-feedback-${index + 1}`,
        order: Number.isFinite(raw.order)
          ? Math.max(1, Math.round(raw.order))
          : index + 1,
        kind,
        slideId,
        pageIndex: Number.isInteger(raw.pageIndex) ? raw.pageIndex : undefined,
        line: Number.isInteger(raw.line) ? raw.line : undefined,
        column: Number.isInteger(raw.column) ? raw.column : undefined,
        targetLabel: cleanString(raw.targetLabel),
        note,
        source: cleanString(raw.source),
        payload: raw.payload,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

export function normalizeVaultContextAttachments(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const slug = cleanString(raw.slug);
      if (!slug || seen.has(slug)) return null;
      seen.add(slug);
      const kind =
        raw.kind === 'skill-package' || raw.kind === 'prompt-context'
          ? raw.kind
          : cleanString(raw.skillPath)
            ? 'skill-package'
            : 'prompt-context';
      return {
        slug,
        title: cleanString(raw.title) || slug,
        kind,
        packageType: cleanString(raw.packageType),
        summary: compactString(raw.summary, 360),
        previewImage: cleanString(raw.previewImage),
        activationPrompt: compactString(raw.activationPrompt, 500),
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

export function renderVaultContextAttachmentHint(items) {
  if (!items.length) return '';
  const lines = [
    '',
    '',
    '<attached-design-vault-contexts>',
    'The user selected these Design Vault contexts for this turn. The daemon has injected the readable context files into the instructions above. Use them as authoritative design input.',
  ];
  for (const item of items) {
    lines.push(
      '',
      `- ${item.title}`,
      `  slug: ${item.slug}`,
      `  kind: ${item.kind}`,
      item.packageType ? `  packageType: ${item.packageType}` : '',
      item.activationPrompt ? `  activationPrompt: ${item.activationPrompt}` : '',
    );
  }
  lines.push('</attached-design-vault-contexts>');
  return lines.filter((line) => line !== '').join('\n');
}

export function renderSlideFeedbackAttachmentHint(items) {
  if (!items.length) return '';
  const lines = [
    '',
    '',
    '<attached-slide-feedback>',
    'Scope: apply these requests to the Open Slide source deck. The canonical source is slides/<slideId>/index.tsx. Preserve unrelated pages and design tokens unless a feedback item explicitly asks to change them.',
  ];
  for (const item of items) {
    lines.push(
      '',
      `${item.order}. ${item.kind}`,
      `id: ${item.id}`,
      `slideId: ${item.slideId}`,
      item.pageIndex == null ? 'page: (unspecified)' : `page: ${item.pageIndex + 1}`,
      item.line == null ? 'source: (no line)' : `source: line ${item.line}${item.column == null ? '' : `, column ${item.column}`}`,
      `target: ${item.targetLabel || '(unspecified)'}`,
      `origin: ${item.source || '(unknown)'}`,
      `note: ${item.note}`,
      item.payload === undefined ? '' : `payload: ${JSON.stringify(item.payload).slice(0, 2000)}`,
    );
  }
  lines.push('</attached-slide-feedback>');
  return lines.filter((line) => line !== '').join('\n');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function compactString(value, max) {
  const text = cleanString(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

const MAX_COMPONENT_MOTION_RECIPES = 6;

function cleanStringList(value, max = 12) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter(Boolean).slice(0, max);
}

function normalizeComponentMotionRecipe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = cleanString(value.id);
  const component = cleanString(value.component);
  if (!id || !component) return null;
  const timing = value.timing && typeof value.timing === 'object' && !Array.isArray(value.timing)
    ? value.timing
    : {};
  const confidence = cleanString(value.confidence);
  return {
    id,
    component,
    role: cleanString(value.role),
    trigger: cleanString(value.trigger),
    statePair: cleanString(value.statePair),
    properties: cleanStringList(value.properties, 8),
    timing: {
      duration: cleanString(timing.duration),
      easing: cleanString(timing.easing),
      ...(cleanString(timing.delay) ? { delay: cleanString(timing.delay) } : {}),
      ...(cleanString(timing.stagger) ? { stagger: cleanString(timing.stagger) } : {}),
    },
    choreography: cleanStringList(value.choreography, 6),
    cssHint: cleanString(value.cssHint),
    pptAdapter: cleanStringList(value.pptAdapter, 6),
    evidence: cleanStringList(value.evidence, 8),
    confidence: ['low', 'medium', 'high'].includes(confidence) ? confidence : 'medium',
  };
}

function normalizeComponentMotionRecipes(value, max = MAX_COMPONENT_MOTION_RECIPES) {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeComponentMotionRecipe)
    .filter(Boolean)
    .slice(0, max);
}

function compactMotionRecipeSummary(value) {
  const recipes = normalizeComponentMotionRecipes(value, 4);
  if (recipes.length === 0) return '';
  return recipes.map((recipe) => {
    const component = compactString(recipe.component, 26);
    const trigger = compactString(recipe.trigger || recipe.statePair, 28);
    const properties = recipe.properties.length > 0
      ? recipe.properties.slice(0, 3).join('/')
      : motionKindForRecipe(recipe);
    return `${component}:${trigger}->${properties}`;
  }).join(' / ');
}

function motionRecipeSignal(recipe) {
  return [
    recipe.id,
    recipe.component,
    recipe.role,
    recipe.trigger,
    recipe.statePair,
    recipe.cssHint,
    ...(recipe.properties ?? []),
    ...(recipe.pptAdapter ?? []),
  ].join(' ').toLowerCase();
}

function motionKindForRecipe(recipe) {
  const signal = motionRecipeSignal(recipe);
  if (/(line|width|progress|underline|stroke)/.test(signal)) return 'line-grow';
  if (/(clip|mask|reveal|wipe)/.test(signal)) return 'mask-reveal';
  if (/(scale|hover|active|press|tap|pulse)/.test(signal)) return 'scale-pop';
  if (/(opacity|transform|slide-enter|off-canvas|enter|fade|translate)/.test(signal)) return 'fade-up';
  return 'settle';
}

function safeMotionCssId(value, fallback) {
  const text = cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52);
  return text || fallback;
}

function cssTimeMs(value, fallbackMs) {
  const match = cleanString(value).match(/(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return fallbackMs;
  return match[2].toLowerCase() === 's' ? Math.round(amount * 1000) : Math.round(amount);
}

function cssEasing(value, fallback = 'cubic-bezier(0.22, 0.72, 0.18, 1)') {
  const text = cleanString(value);
  if (/^cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)$/i.test(text)) {
    return text;
  }
  if (/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/i.test(text)) {
    return text;
  }
  return fallback;
}

function keyframesForMotionKind(name, kind) {
  if (kind === 'line-grow') {
    return `@keyframes ${name} {
  from { opacity: 0.45; transform: scaleX(0); }
  to { opacity: 1; transform: scaleX(1); }
}`;
  }
  if (kind === 'mask-reveal') {
    return `@keyframes ${name} {
  from { opacity: 0; clip-path: inset(0 0 100% 0); transform: translate3d(0, 18px, 0); }
  to { opacity: 1; clip-path: inset(0 0 0 0); transform: translate3d(0, 0, 0); }
}`;
  }
  if (kind === 'scale-pop') {
    return `@keyframes ${name} {
  0% { opacity: 0; transform: scale(0.96); }
  70% { opacity: 1; transform: scale(1.018); }
  100% { opacity: 1; transform: scale(1); }
}`;
  }
  if (kind === 'settle') {
    return `@keyframes ${name} {
  from { opacity: 0.92; transform: translate3d(0, 14px, 0) scale(0.992); }
  to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}`;
  }
  return `@keyframes ${name} {
  from { opacity: 0; transform: translate3d(0, 34px, 0); filter: blur(4px); }
  to { opacity: 1; transform: translate3d(0, 0, 0); filter: blur(0); }
}`;
}

export function buildVaultMotionStyles(componentMotionRecipes) {
  const recipes = normalizeComponentMotionRecipes(componentMotionRecipes);
  const motionFromRecipe = {};
  const recipeIds = [];
  const css = [];
  recipes.forEach((recipe, index) => {
    const safeId = safeMotionCssId(recipe.id, `recipe-${index + 1}`);
    const className = `os-motion os-dv-motion-${safeId}`;
    const kind = motionKindForRecipe(recipe);
    const keyframesName = `openppt-dv-${safeId}`;
    const durationMs = cssTimeMs(recipe.timing?.duration, 620);
    const delayMs = cssTimeMs(recipe.timing?.delay, index * 80);
    const staggerMs = cssTimeMs(recipe.timing?.stagger, 0);
    const easing = cssEasing(recipe.timing?.easing);
    const hasStagger = staggerMs > 0 || /stagger|sequence|cascade/i.test(motionRecipeSignal(recipe));
    motionFromRecipe[recipe.id] = hasStagger
      ? `${className} os-motion-stagger`
      : className;
    recipeIds.push(recipe.id);
    css.push(keyframesForMotionKind(keyframesName, kind));
    css.push(`.os-dv-motion-${safeId} {
  animation-name: ${keyframesName};
  animation-duration: ${durationMs}ms;
  animation-timing-function: ${easing};
  animation-delay: ${delayMs}ms;
  transform-origin: ${kind === 'line-grow' ? 'left center' : 'center center'};
  will-change: opacity, transform, clip-path, filter;
}`);
    if (/hover|active|press|tap/i.test(recipe.trigger || recipe.statePair || recipe.role)) {
      css.push(`.os-dv-motion-${safeId}:hover {
  transform: translate3d(0, -4px, 0) scale(1.018);
  transition: transform ${Math.max(150, Math.min(durationMs, 420))}ms ${easing};
}`);
    }
    if (hasStagger) {
      for (let child = 1; child <= 6; child += 1) {
        const childDelay = delayMs + child * (staggerMs || 70);
        css.push(`.os-dv-motion-${safeId} > *:nth-child(${child}) {
  animation: ${keyframesName} ${Math.max(180, Math.min(durationMs, 900))}ms ${easing} ${childDelay}ms both;
}`);
      }
    }
    css.push(`[data-osd-freeze-motion] .os-dv-motion-${safeId},
[data-osd-freeze-motion] .os-dv-motion-${safeId} > * {
  animation: none !important;
  opacity: 1 !important;
  transform: none !important;
  clip-path: none !important;
  filter: none !important;
}`);
    css.push(`@media (prefers-reduced-motion: reduce) {
  .os-dv-motion-${safeId},
  .os-dv-motion-${safeId} > * {
    animation: none !important;
    transition: none !important;
    opacity: 1 !important;
    transform: none !important;
    clip-path: none !important;
    filter: none !important;
  }
}`);
  });
  return {
    css: css.join('\n\n'),
    motionFromRecipe,
    recipeIds,
  };
}

function normalizeAttachmentPosition(input) {
  const value = input && typeof input === 'object' ? input : {};
  return {
    x: finiteAttachmentNumber(value.x),
    y: finiteAttachmentNumber(value.y),
    width: finiteAttachmentNumber(value.width),
    height: finiteAttachmentNumber(value.height),
  };
}

function finiteAttachmentNumber(value) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function formatAttachmentPosition(position) {
  return `x=${position.x}, y=${position.y}, width=${position.width}, height=${position.height}`;
}

function isPathWithin(base, target) {
  const relativePath = path.relative(path.resolve(base), path.resolve(target));
  return (
    relativePath === '' ||
    (relativePath.length > 0 &&
      !relativePath.startsWith('..') &&
      !path.isAbsolute(relativePath))
  );
}

const OPENPPT_DEFAULT_DESIGN = {
  palette: { bg: '#0f172a', text: '#f8fafc', accent: '#38bdf8' },
  fonts: {
    display: 'system-ui, -apple-system, BlinkMacSystemFont, "Inter", sans-serif',
    body: 'system-ui, -apple-system, BlinkMacSystemFont, "Inter", sans-serif',
  },
  typeScale: { hero: 156, body: 38 },
  radius: 12,
};

export function openPptDesignFromVaultTemplate(vaultTemplate, baseDesign = OPENPPT_DEFAULT_DESIGN) {
  const base = baseDesign && typeof baseDesign === 'object' && !Array.isArray(baseDesign)
    ? baseDesign
    : OPENPPT_DEFAULT_DESIGN;
  const colorRoles = vaultTemplate?.colorRoles;
  const typographyRoles = vaultTemplate?.typographyRoles;
  const patch = {};
  if (colorRoles && typeof colorRoles === 'object') {
    const bg = cleanString(colorRoles.background);
    const text = cleanString(colorRoles.text);
    const accent =
      cleanString(colorRoles.brandPrimary) ||
      cleanString(colorRoles.brandSecondary);
    patch.palette = {
      ...(bg ? { bg } : {}),
      ...(text ? { text } : {}),
      ...(accent ? { accent } : {}),
    };
  }
  if (typographyRoles && typeof typographyRoles === 'object') {
    const display = vaultFontStack(typographyRoles.display, OPENPPT_DEFAULT_DESIGN.fonts.display);
    const body = vaultFontStack(typographyRoles.body || typographyRoles.primary, OPENPPT_DEFAULT_DESIGN.fonts.body);
    patch.fonts = {
      ...(display ? { display } : {}),
      ...(body ? { body } : {}),
    };
  }
  patch.motion = {
    componentMotionRecipes: normalizeComponentMotionRecipes(vaultTemplate?.componentMotionRecipes),
    approach: Array.isArray(vaultTemplate?.openSlideGuidance?.motionApproach)
      ? vaultTemplate.openSlideGuidance.motionApproach.map(cleanString).filter(Boolean)
      : [],
  };
  return mergeOpenPptDesign(base, patch);
}

function vaultFontStack(value, fallback) {
  const font = vaultFontFamilyName(value);
  if (!font) return fallback;
  return `"${font.replace(/"/g, '\\"')}", ${fallback || OPENPPT_DEFAULT_DESIGN.fonts.body}`;
}

function vaultFontFamilyName(value) {
  const raw = cleanString(value);
  if (!raw || /^var\(/i.test(raw)) return '';
  const withoutExplanation = raw
    .split(/\s+[—–]\s+/)[0]
    .split(/\s+-\s+/)[0]
    .split(',')[0]
    .trim();
  return withoutExplanation
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function vaultTemplateMetadataFromDesign(design) {
  if (!design || typeof design !== 'object') return null;
  const profile = design.profile && typeof design.profile === 'object' ? design.profile : {};
  const previews = design.previews && typeof design.previews === 'object' ? design.previews : {};
  const context = await normalizeVaultAgentContext(design);
  const previewImage = context ? localPreviewUrlForVaultContext(context) : undefined;
  return {
    slug: cleanString(design.slug),
    title: cleanString(design.title) || cleanString(design.slug),
    kind: context?.kind,
    packageType: context?.packageType,
    sourceUrl: cleanString(design.sourceUrl),
    sourceHost: cleanString(design.sourceHost),
    summary: cleanString(design.summary),
    tags: context?.tags,
    previewImage,
    manifestPath: context?.manifestPath,
    capabilitiesPath: context?.capabilitiesPath,
    skillPath: context?.skillPath,
    archetype: cleanString(profile.archetype),
    confidence: cleanString(profile.confidence),
    visualThesis: cleanString(profile.visualThesis),
    toneTags: Array.isArray(profile.toneTags) ? profile.toneTags.map(cleanString).filter(Boolean) : undefined,
    useCaseTags: Array.isArray(profile.useCaseTags) ? profile.useCaseTags.map(cleanString).filter(Boolean) : undefined,
    audienceFit: Array.isArray(profile.audienceFit) ? profile.audienceFit.map(cleanString).filter(Boolean) : undefined,
    contentDensity: profile.contentDensity,
    narrativeFit: Array.isArray(profile.narrativeFit) ? profile.narrativeFit.map(cleanString).filter(Boolean) : undefined,
    avoidWhen: Array.isArray(profile.avoidWhen) ? profile.avoidWhen.map(cleanString).filter(Boolean) : undefined,
    matchingRationale: Array.isArray(profile.matchingRationale) ? profile.matchingRationale.map(cleanString).filter(Boolean) : undefined,
    slidePatterns: Array.isArray(profile.slidePatterns) ? profile.slidePatterns.map(cleanString).filter(Boolean) : undefined,
    typographyPersonality: cleanString(profile.typographyPersonality),
    layoutIntensity: cleanString(profile.layoutIntensity),
    assetNeeds: Array.isArray(profile.assetNeeds) ? profile.assetNeeds.map(cleanString).filter(Boolean) : undefined,
    mediaPromptGrammar: Array.isArray(profile.mediaPromptGrammar)
      ? profile.mediaPromptGrammar.map(cleanString).filter(Boolean)
      : cleanString(profile.mediaPromptGrammar),
    localizationFit: cleanString(profile.localizationFit),
    colorRoles: profile.colorRoles && typeof profile.colorRoles === 'object' ? profile.colorRoles : undefined,
    typographyRoles: profile.typographyRoles && typeof profile.typographyRoles === 'object' ? profile.typographyRoles : undefined,
    openSlideGuidance: profile.openSlideGuidance && typeof profile.openSlideGuidance === 'object' ? profile.openSlideGuidance : undefined,
    componentMotionRecipes: normalizeComponentMotionRecipes(profile.componentMotionRecipes),
    designPath: cleanString(design.designPath),
    openSlideThemePath: cleanString(design.openSlideThemePath),
    tokensPath: context?.tokensPath,
    tokenStylesheet: context?.tokenStylesheet ?? undefined,
    evidencePath: cleanString(design.evidencePath),
    profilePath: cleanString(design.profilePath),
    references: context?.references,
    activationPrompt: context?.activationPrompt,
    previewPpt: cleanString(previews.ppt),
    previewWeb: cleanString(previews.web),
  };
}

async function fetchVaultTemplateMetadata(slug) {
  const safeSlug = cleanString(slug);
  if (!safeSlug) throw new Error('vault template slug required');
  let design = null;
  try {
    const result = await fetchVaultJson(`/api/designs/${encodeURIComponent(safeSlug)}`);
    if (result.ok) design = result.json?.design ?? result.json;
  } catch {
    design = null;
  }
  if (!design) {
    const localDesign = await loadLocalVaultDesignForClient(safeSlug);
    if (localDesign) {
      const localMetadata = await vaultTemplateMetadataFromDesign(localDesign);
      if (localMetadata?.slug) return localMetadata;
    }
    const localContext = await loadVaultAgentContextFromLocalSlug(safeSlug);
    if (localContext) return localContext;
    throw new Error(`Design Vault template "${safeSlug}" unavailable`);
  }
  const metadata = await vaultTemplateMetadataFromDesign(design);
  if (!metadata?.slug) throw new Error(`Design Vault template "${safeSlug}" returned invalid metadata`);
  return metadata;
}

function normalizeHexColor(value) {
  const text = cleanString(value).toLowerCase();
  const hex = text.match(/^#?([0-9a-f]{6})$/i)?.[1];
  return hex ? `#${hex}` : text;
}

function openPptVaultTemplateGate(metadata, source) {
  const vault = metadata?.vaultTemplate;
  if (metadata?.kind !== 'deck' || !vault) return null;
  const parsed = parseOpenPptDesign(source);
  if (parsed.warning) {
    return `Selected Vault template "${vault.title || vault.slug}" is locked, but SFA could not parse the deck design tokens: ${parsed.warning}`;
  }
  const design = parsed.design ?? {};
  const palette = design.palette && typeof design.palette === 'object' ? design.palette : {};
  const fonts = design.fonts && typeof design.fonts === 'object' ? design.fonts : {};
  const defaultAccent = normalizeHexColor(OPENPPT_DEFAULT_DESIGN.palette.accent);
  const selectedAccent = normalizeHexColor(vault?.colorRoles?.brandPrimary || vault?.colorRoles?.brandSecondary);
  const currentAccent = normalizeHexColor(palette.accent);
  const usesDefaultAccent =
    currentAccent === defaultAccent &&
    selectedAccent &&
    selectedAccent !== defaultAccent;
  const selectedFamilies = [
    vaultFontFamilyName(vault?.typographyRoles?.display),
    vaultFontFamilyName(vault?.typographyRoles?.body),
    vaultFontFamilyName(vault?.typographyRoles?.primary),
  ].filter(Boolean);
  const currentDisplay = `${cleanString(fonts.display)} ${cleanString(fonts.body)}`;
  const currentDisplayLower = currentDisplay.toLowerCase();
  const hasSelectedFamily = selectedFamilies.some((family) =>
    currentDisplayLower.includes(family.toLowerCase()),
  );
  const usesDefaultInter =
    selectedFamilies.some((family) => !/inter|system-ui|-apple-system/i.test(family)) &&
    !hasSelectedFamily &&
    /(^|["',\s])inter(["',\s]|$)|system-ui|-apple-system/i.test(currentDisplay);
  if (usesDefaultAccent || usesDefaultInter) {
    return [
      `Selected Vault template "${vault.title || vault.slug}" is locked, but the deck still appears to use SFA fallback tokens.`,
      usesDefaultAccent ? `accent is still ${OPENPPT_DEFAULT_DESIGN.palette.accent}` : null,
      usesDefaultInter ? 'display/body font still appears to be Inter/system sans fallback' : null,
      'Apply the selected template to the current deck before exporting or delivering.',
    ].filter(Boolean).join(' ');
  }
  return null;
}

function hasOpenPptGeneratedMediaEmbed(source) {
  const text = typeof source === 'string' ? source : '';
  const imageAssetRef =
    /['"`](?:\.\/assets\/|slides\/[a-z0-9_-]+\/assets\/)[^'"`]+\.(?:png|jpe?g|webp|gif|avif)['"`]/i.test(
      text,
    );
  if (!imageAssetRef) return false;
  return /<img\b|backgroundImage\s*:|url\(/i.test(text);
}

export function openPptDeckMediaGate(metadata, source) {
  const media = metadata?.deckMedia;
  if (metadata?.kind !== 'deck') return null;
  const explicitMediaPlaceholder = /Media-model image|gpt-image-\d|媒体模型|data-openppt-media-status=["']pending["']/i.test(source);
  if (!(media?.enabled || media?.required || explicitMediaPlaceholder)) return null;
  const unresolved =
    /<ImagePlaceholder\b|Media-model image|insert generated image|generated image placeholder|image placeholder|AI\s*(?:image|illustration)\s*placeholder|data-openppt-media-status=["']pending["']/i.test(
      source,
    );
  const missingRequiredEmbed =
    media?.required === true && !hasOpenPptGeneratedMediaEmbed(source);
  if (!unresolved && !missingRequiredEmbed) return null;
  return [
    missingRequiredEmbed
      ? 'This SFA deck requires generated media assets, but the source does not embed any generated image file from slides/<slideId>/assets/ yet.'
      : 'This SFA deck requires generated media assets, but the source still contains unresolved image placeholders.',
    media?.imageModel
      ? `Expected configured model: ${media.imageModel}.`
      : 'No deck media model is configured; do not run od media generate without --model. Choose an available image model or keep the deck marked needs media replacement until the asset is supplied.',
    media?.imageModel
      ? 'Run the media dispatcher, save real files under slides/<slideId>/assets/, import them in the TSX source, then export again.'
      : 'After a model is selected, run the media dispatcher, save real files under slides/<slideId>/assets/, import them in the TSX source, then export again.',
  ].join(' ');
}

function slugifySlideId(input) {
  const base = cleanString(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return base || 'untitled-deck';
}

function isSafeSlideId(slideId) {
  return typeof slideId === 'string' && /^[a-z0-9][a-z0-9_-]{0,80}$/i.test(slideId);
}

function openPptSlidePath(cwd, slideId) {
  if (!isSafeSlideId(slideId)) return null;
  const slidesRoot = path.join(cwd, 'slides');
  const file = path.join(slidesRoot, slideId, 'index.tsx');
  return isPathWithin(slidesRoot, file) ? file : null;
}

function openPptSlideRelativePath(slideId) {
  return `slides/${slideId}/index.tsx`;
}

export function renderOpenPptStarterSlide({ title, vaultTemplate }) {
  const safeTitle = JSON.stringify(title || 'Untitled Web-PPT');
  const starterDesign = openPptDesignFromVaultTemplate(vaultTemplate);
  const vaultMotion = buildVaultMotionStyles(vaultTemplate?.componentMotionRecipes);
  const eyebrow = vaultTemplate?.title
    ? JSON.stringify(`DESIGN VAULT / ${vaultTemplate.title}`)
    : JSON.stringify('OPENPPT / WEB-PPT');
  return `import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';

export const design: DesignSystem = ${JSON.stringify(starterDesign, null, 2)};

const fill = {
  width: '100%',
  height: '100%',
  background: 'var(--osd-bg)',
  color: 'var(--osd-text)',
  fontFamily: 'var(--osd-font-body)',
} as const;

const motionStyles = \`
@keyframes openpptFadeUp {
  from { opacity: 0; transform: translate3d(0, 34px, 0); filter: blur(4px); }
  to { opacity: 1; transform: translate3d(0, 0, 0); filter: blur(0); }
}

@keyframes openpptLineGrow {
  from { opacity: 0.45; transform: scaleX(0); }
  to { opacity: 1; transform: scaleX(1); }
}

@keyframes openpptCanvasSwap {
  from { opacity: 0; transform: translate3d(0, 18px, 0) scale(0.992); }
  to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}

.os-motion {
  animation-duration: 620ms;
  animation-timing-function: cubic-bezier(0.22, 0.72, 0.18, 1);
  animation-fill-mode: both;
}

.os-fade-up {
  animation-name: openpptFadeUp;
}

.os-line-grow {
  transform-origin: left center;
  animation-name: openpptLineGrow;
}

.os-canvas-swap {
  animation-name: openpptCanvasSwap;
  animation-duration: 520ms;
}

.os-motion-stagger > * {
  animation: openpptFadeUp 560ms cubic-bezier(0.22, 0.72, 0.18, 1) both;
}

.os-motion-stagger > *:nth-child(1) { animation-delay: 90ms; }
.os-motion-stagger > *:nth-child(2) { animation-delay: 150ms; }
.os-motion-stagger > *:nth-child(3) { animation-delay: 210ms; }
.os-motion-stagger > *:nth-child(4) { animation-delay: 270ms; }
.os-motion-stagger > *:nth-child(5) { animation-delay: 330ms; }
.os-motion-stagger > *:nth-child(6) { animation-delay: 390ms; }

[data-osd-freeze-motion] .os-motion,
[data-osd-freeze-motion] .os-fade-up,
[data-osd-freeze-motion] .os-line-grow,
[data-osd-freeze-motion] .os-canvas-swap,
[data-osd-freeze-motion] .os-motion-stagger > * {
  animation: none !important;
  opacity: 1 !important;
  transform: none !important;
  clip-path: none !important;
  filter: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .os-motion,
  .os-motion-stagger > * {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
    filter: none !important;
  }
}

${vaultMotion.css}
\`;

const MotionStyles = () => <style>{motionStyles}</style>;
const fadeUp = 'os-motion os-fade-up';
const lineGrow = 'os-motion os-line-grow';
const stagger = 'os-motion-stagger';
const canvasSwap = 'os-motion os-canvas-swap';
const motionDelay = (delay: number) => ({ animationDelay: \`\${delay}ms\` });
const motionFromRecipe = ${JSON.stringify(vaultMotion.motionFromRecipe, null, 2)} as const;
const motionAttrs = (id: keyof typeof motionFromRecipe) => ({
  className: motionFromRecipe[id],
  "data-osd-motion-id": id,
});
const vaultMotionIds = Object.keys(motionFromRecipe) as Array<keyof typeof motionFromRecipe>;
const recipeMotion = (index: number, fallback: string) => {
  const id = vaultMotionIds.length > 0 ? vaultMotionIds[index % vaultMotionIds.length] : undefined;
  return id ? motionAttrs(id) : { className: fallback };
};

const Cover: Page = () => (
  <div
    className={canvasSwap}
    style={{
      ...fill,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '0 150px',
    }}
  >
    <MotionStyles />
    <div {...recipeMotion(0, fadeUp)} style={{ ...motionDelay(80), color: 'var(--osd-accent)', fontSize: 28, fontWeight: 800, letterSpacing: '0.18em' }}>
      {${eyebrow}}
    </div>
    <h1
      {...recipeMotion(1, fadeUp)}
      style={{
        ...motionDelay(150),
        maxWidth: 1320,
        margin: '34px 0 0',
        fontFamily: 'var(--osd-font-display)',
        fontSize: 'var(--osd-size-hero)',
        fontWeight: 900,
        lineHeight: 1.02,
      }}
    >
      {${safeTitle}}
    </h1>
    <div {...recipeMotion(2, lineGrow)} style={{ ...motionDelay(220), width: 520, height: 2, marginTop: 38, background: 'var(--osd-accent)' }} />
    <p {...recipeMotion(0, fadeUp)} style={{ ...motionDelay(280), maxWidth: 1060, margin: '42px 0 0', color: 'color-mix(in srgb, var(--osd-text), transparent 28%)', fontSize: 'var(--osd-size-body)', lineHeight: 1.35 }}>
      Start from the chat on the left. The agent will build and revise this editable Open Slide deck.
    </p>
  </div>
);

const Workflow: Page = () => (
  <div className={canvasSwap} style={{ ...fill, padding: 130 }}>
    <MotionStyles />
    <h2 {...recipeMotion(1, fadeUp)} style={{ ...motionDelay(80), margin: 0, fontFamily: 'var(--osd-font-display)', fontSize: 86, lineHeight: 1.08 }}>
      Editable Web-PPT source
    </h2>
    <div {...recipeMotion(2, lineGrow)} style={{ ...motionDelay(160), width: 780, height: 2, marginTop: 36, background: 'var(--osd-accent)' }} />
    <div className={stagger} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 28, marginTop: 74 }}>
      {['Semantic build', 'Inspect feedback', 'Export options'].map((item, index) => (
        <section
          key={item}
          {...recipeMotion(index, fadeUp)}
          style={{
            minHeight: 360,
            border: '1px solid color-mix(in srgb, var(--osd-text), transparent 82%)',
            borderRadius: 'var(--osd-radius)',
            padding: 34,
            background: 'color-mix(in srgb, var(--osd-accent), transparent 88%)',
          }}
        >
          <div style={{ color: 'var(--osd-accent)', fontSize: 26, fontWeight: 800 }}>0{index + 1}</div>
          <h3 style={{ margin: '42px 0 0', fontSize: 46, lineHeight: 1.1 }}>{item}</h3>
          <p style={{ margin: '24px 0 0', color: 'color-mix(in srgb, var(--osd-text), transparent 32%)', fontSize: 30, lineHeight: 1.45 }}>
            This project stores the canonical deck as React pages under slides/.
          </p>
        </section>
      ))}
    </div>
  </div>
);

export const meta: SlideMeta = { title: ${safeTitle} };
export default [Cover, Workflow] satisfies Page[];
`;
}

async function ensureOpenPptSlideProject(projectRoot, projectId, project) {
  if (project?.metadata?.kind !== 'deck') return project;
  const cwd = await ensureProject(projectRoot, projectId);
  const slideId = isSafeSlideId(project.metadata?.slideId)
    ? project.metadata.slideId
    : slugifySlideId(project.name);
  const file = openPptSlidePath(cwd, slideId);
  if (!file) throw new Error('invalid slide id');
  if (!fs.existsSync(file)) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(
      file,
      renderOpenPptStarterSlide({
        title: project.name,
        vaultTemplate: project.metadata?.vaultTemplate,
      }),
      'utf8',
    );
  }
  const metadata = {
    ...(project.metadata ?? {}),
    kind: 'deck',
    slideId,
    slideWorkspace: 'slides',
    deliveryOptions: {
      html: true,
      pdf: true,
      pptx: true,
      ...(project.metadata?.deliveryOptions ?? {}),
    },
  };
  return { metadata, entryFile: openPptSlideRelativePath(slideId) };
}

function parseOpenPptDesign(source) {
  const match = source.match(/export\s+const\s+design(?:\s*:\s*DesignSystem)?\s*=\s*(\{[\s\S]*?\n\});/m);
  if (!match) return { design: OPENPPT_DEFAULT_DESIGN, exists: false, warning: null };
  try {
    const parsed = new Function(`"use strict"; return (${match[1]});`)();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('design export must be an object');
    }
    return {
      design: mergeOpenPptDesign(OPENPPT_DEFAULT_DESIGN, parsed),
      exists: true,
      warning: null,
    };
  } catch (err) {
    return { design: OPENPPT_DEFAULT_DESIGN, exists: true, warning: String(err?.message || err) };
  }
}

function writeOpenPptDesign(source, design) {
  const literal = JSON.stringify(design, null, 2);
  const block = `export const design: DesignSystem = ${literal};`;
  if (/export\s+const\s+design(?:\s*:\s*DesignSystem)?\s*=\s*\{[\s\S]*?\n\};/m.test(source)) {
    return source.replace(/export\s+const\s+design(?:\s*:\s*DesignSystem)?\s*=\s*\{[\s\S]*?\n\};/m, block);
  }
  return source.replace(/(import\s+type\s+\{[^}]*DesignSystem[^}]*\}\s+from\s+['"]@open-slide\/core['"];?\n)/, `$1\n${block}\n`);
}

const SLIDE_COMMENT_RE = /\{\/\*\s*@slide-comment\s+id="(c-[a-f0-9]+)"\s+ts="([^"]+)"\s+text="([A-Za-z0-9_\-]+={0,2})"\s*\*\/\}/g;

function b64urlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(value) {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function parseSlideComments(source) {
  const comments = [];
  for (const match of source.matchAll(SLIDE_COMMENT_RE)) {
    let note = '';
    let hint;
    try {
      const parsed = JSON.parse(b64urlDecode(match[3]));
      note = cleanString(parsed.note);
      hint = cleanString(parsed.hint) || undefined;
    } catch {
      note = '(unreadable comment)';
    }
    comments.push({
      id: match[1],
      line: source.slice(0, match.index).split('\n').length,
      ts: match[2],
      note,
      hint,
    });
  }
  return comments;
}

function insertSlideComment(source, { line, text, hint }) {
  const lines = source.split('\n');
  const index = Math.max(0, Math.min(lines.length - 1, Number(line) - 1));
  const id = `c-${randomId().replace(/[^a-f0-9]/gi, '').slice(0, 8).padEnd(8, '0')}`;
  const payload = b64urlEncode(JSON.stringify({ note: text, hint }));
  const insertIndex = findSafeSlideCommentInsertIndex(lines, index);
  const indent = lines[insertIndex]?.match(/^\s*/)?.[0] ?? lines[index]?.match(/^\s*/)?.[0] ?? '';
  lines.splice(insertIndex, 0, `${indent}{/* @slide-comment id="${id}" ts="${new Date().toISOString()}" text="${payload}" */}`);
  return { id, source: lines.join('\n') };
}

function findSafeSlideCommentInsertIndex(lines, targetIndex) {
  const openingTagIndex = findUnclosedJsxOpeningTagStart(lines, targetIndex);
  if (openingTagIndex != null) return openingTagIndex;
  return Math.max(0, Math.min(lines.length, targetIndex + 1));
}

function findUnclosedJsxOpeningTagStart(lines, targetIndex) {
  const min = Math.max(0, targetIndex - 12);
  for (let index = targetIndex; index >= min; index -= 1) {
    const line = lines[index] ?? '';
    if (/^\s*<[A-Za-z][A-Za-z0-9_.:-]*\b/.test(line)) {
      const segment = lines.slice(index, targetIndex + 1).join('\n');
      return segment.includes('>') ? null : index;
    }
    if (line.includes('>') || line.includes(');')) break;
  }
  return null;
}

function removeSlideComment(source, id) {
  const lines = source.split('\n');
  const idRe = new RegExp(`\\{\\/\\*\\s*@slide-comment\\s+id="${id}"\\s+ts="[^"]+"\\s+text="[A-Za-z0-9_\\-]+={0,2}"\\s*\\*\\/\\}`);
  const next = lines.filter((line) => !idRe.test(line));
  return { removed: next.length !== lines.length, source: next.join('\n') };
}

// open-design companion-app registry: lets the daemon discover a running
// design-vault instance without requiring users to set OPENPPT_VAULT_ORIGIN.
// See SPEC.md for the file shape. Refreshed every 10s in the background.
const OPEN_DESIGN_REGISTRY_FRESHNESS_MS = 90_000;
const OPEN_DESIGN_REGISTRY_REFRESH_MS = 10_000;
const OPEN_DESIGN_AUTODETECT_DEFAULT = true;
let openDesignRegistryCache = {
  baseUrl: null,
  version: null,
  port: null,
  pid: null,
  lastSeen: null,
  spec: null,
  capabilities: [],
  fresh: false,
  loadedAt: 0,
};
let openDesignRegistryTimer = null;

function openDesignRegistryPath() {
  const xdg = (process.env.XDG_CONFIG_HOME || '').trim();
  const base = xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'open-design', 'registry.json');
}

function openDesignAutodetectEnabled() {
  const flag = (process.env.OPENPPT_VAULT_AUTODETECT || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  return OPEN_DESIGN_AUTODETECT_DEFAULT;
}

async function readOpenDesignRegistry() {
  if (!openDesignAutodetectEnabled()) return null;
  const filePath = openDesignRegistryPath();
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const entry = parsed?.apps?.['design-vault'];
    if (!entry || typeof entry !== 'object') return null;
    const lastSeen = typeof entry.lastSeen === 'string' ? Date.parse(entry.lastSeen) : NaN;
    const fresh = Number.isFinite(lastSeen) && Date.now() - lastSeen < OPEN_DESIGN_REGISTRY_FRESHNESS_MS;
    return {
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : null,
      version: typeof entry.version === 'string' ? entry.version : null,
      port: typeof entry.port === 'number' ? entry.port : null,
      pid: typeof entry.pid === 'number' ? entry.pid : null,
      lastSeen: typeof entry.lastSeen === 'string' ? entry.lastSeen : null,
      spec: typeof entry.spec === 'string' ? entry.spec : null,
      capabilities: Array.isArray(entry.capabilities) ? entry.capabilities.filter((value) => typeof value === 'string') : [],
      fresh,
    };
  } catch {
    return null;
  }
}

async function refreshOpenDesignRegistryCache() {
  const entry = await readOpenDesignRegistry();
  openDesignRegistryCache = {
    baseUrl: entry?.baseUrl ?? null,
    version: entry?.version ?? null,
    port: entry?.port ?? null,
    pid: entry?.pid ?? null,
    lastSeen: entry?.lastSeen ?? null,
    spec: entry?.spec ?? null,
    capabilities: entry?.capabilities ?? [],
    fresh: Boolean(entry?.fresh && entry?.baseUrl),
    loadedAt: Date.now(),
  };
  return openDesignRegistryCache;
}

function startOpenDesignRegistryWatcher() {
  if (openDesignRegistryTimer) return;
  void refreshOpenDesignRegistryCache().catch(() => {});
  openDesignRegistryTimer = setInterval(() => {
    void refreshOpenDesignRegistryCache().catch(() => {});
  }, OPEN_DESIGN_REGISTRY_REFRESH_MS);
  if (typeof openDesignRegistryTimer.unref === 'function') openDesignRegistryTimer.unref();
}

async function probeVaultHealth(origin, timeoutMs = 800) {
  if (!origin) return { ok: false };
  let controller = null;
  let timer = null;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const target = new URL('/api/health', origin);
    const resp = await fetch(target, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, status: resp.status };
    const data = await resp.json().catch(() => null);
    if (!data || data.ok !== true || data.service !== 'design-vault') return { ok: false };
    return { ok: true, data };
  } catch {
    if (timer) clearTimeout(timer);
    return { ok: false };
  }
}

function vaultOrigin() {
  const envOrigin = process.env.OPENPPT_VAULT_ORIGIN || process.env.DESIGN_VAULT_ORIGIN;
  if (envOrigin) return envOrigin;
  if (openDesignRegistryCache.fresh && openDesignRegistryCache.baseUrl) return openDesignRegistryCache.baseUrl;
  return 'http://127.0.0.1:3217';
}

function externalVaultEnabled() {
  if (process.env.OPENPPT_VAULT_ORIGIN || process.env.DESIGN_VAULT_ORIGIN) return true;
  return Boolean(openDesignRegistryCache.fresh && openDesignRegistryCache.baseUrl);
}

function externalVaultExplicitlyConfigured() {
  return Boolean(process.env.OPENPPT_VAULT_ORIGIN || process.env.DESIGN_VAULT_ORIGIN);
}

async function ensureExternalVaultForRequest() {
  await refreshOpenDesignRegistryCache().catch(() => {});
  if (externalVaultEnabled()) return true;
  const origin = vaultOrigin();
  const probe = await probeVaultHealth(origin);
  if (!probe.ok) return false;
  openDesignRegistryCache = {
    ...openDesignRegistryCache,
    baseUrl: origin,
    version: probe.data?.version ?? openDesignRegistryCache.version,
    spec: probe.data?.spec ?? openDesignRegistryCache.spec,
    capabilities: Array.isArray(probe.data?.capabilities) ? probe.data.capabilities : openDesignRegistryCache.capabilities,
    fresh: true,
    loadedAt: Date.now(),
  };
  return true;
}

async function fetchVaultJson(pathname, init) {
  if (!externalVaultEnabled()) {
    throw new Error('external Design Vault service is not configured');
  }
  const target = new URL(pathname, vaultOrigin());
  const resp = await fetch(target, init);
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  return { ok: resp.ok, status: resp.status, json };
}

async function enrichVaultDesignForClient(design, options = {}) {
  if (!design || typeof design !== 'object') return design;
  const context = await normalizeVaultAgentContext(design, options);
  if (!context) return design;
  return {
    ...design,
    kind: context.kind,
    packageType: context.packageType,
    tags: Array.isArray(design.tags) && design.tags.length > 0 ? design.tags : context.tags,
    previewImage: localPreviewUrlForVaultContext(context),
    manifestPath: context.manifestPath,
    capabilitiesPath: context.capabilitiesPath,
    skillPath: context.skillPath,
    designPath: context.designPath ?? design.designPath,
    openSlideThemePath: context.openSlideThemePath ?? design.openSlideThemePath,
    tokensPath: context.tokensPath,
    profilePath: context.profilePath ?? design.profilePath,
    references: context.references,
    activationPrompt: context.activationPrompt,
    previews: {
      ...(design.previews && typeof design.previews === 'object' ? design.previews : {}),
      web: localVaultPreviewPath(context.slug, 'web') || cleanString(design.previews?.web) || '',
      ppt: localVaultPreviewPath(context.slug, 'ppt') || cleanString(design.previews?.ppt) || '',
      card: localVaultPreviewPath(context.slug, 'card') || cleanString(design.previews?.card) || '',
    },
  };
}

async function loadLocalVaultDesignForClient(slug) {
  const safeSlug = cleanString(slug);
  if (!safeSlug) return null;
  const root = path.join(vaultDesignsRoot(), safeSlug);
  let meta = null;
  try {
    meta = JSON.parse(await fs.promises.readFile(path.join(root, 'meta.json'), 'utf8'));
  } catch {
    if (!hasUsableLocalVaultDesign(root, safeSlug)) return null;
    const context = await loadVaultAgentContextFromLocalSlug(safeSlug);
    return context ? enrichVaultDesignForClient(context, { root }) : null;
  }
  return enrichVaultDesignForClient(meta, { root });
}

async function listLocalVaultDesignsForClient() {
  const root = vaultDesignsRoot();
  let entries = [];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const designs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const designRoot = path.join(root, slug);
    if (!hasUsableLocalVaultDesign(designRoot, slug)) continue;
    let meta = null;
    try {
      meta = JSON.parse(await fs.promises.readFile(path.join(designRoot, 'meta.json'), 'utf8'));
    } catch {
      meta = { slug, title: slug };
    }
    designs.push(await enrichVaultDesignForClient(meta, { root: designRoot }));
  }
  return designs.filter(Boolean);
}

function isVaultDesignSlugSegment(slug) {
  return Boolean(
    slug &&
      slug !== '.' &&
      slug !== '..' &&
      !slug.startsWith('.') &&
      !slug.includes('/') &&
      !slug.includes('\\'),
  );
}

async function deleteLocalVaultDesignForClient(slug) {
  const safeSlug = cleanString(slug);
  if (!isVaultDesignSlugSegment(safeSlug)) {
    throw new Error('invalid Design Vault template slug');
  }

  const root = path.resolve(vaultDesignsRoot());
  const target = path.resolve(root, safeSlug);
  if (path.dirname(target) !== root || !isPathWithin(root, target)) {
    throw new Error('invalid Design Vault template path');
  }
  if (!fs.existsSync(target)) return null;
  const stat = await fs.promises.stat(target).catch(() => null);
  if (!stat?.isDirectory()) return null;

  const removedPaths = [target];
  await fs.promises.rm(target, { recursive: true, force: true });

  for (const base of [SKILLS_DIR, DESIGN_SYSTEMS_DIR]) {
    const materialized = path.resolve(base, `dv-${safeSlug}`);
    if (path.dirname(materialized) !== path.resolve(base) || !isPathWithin(base, materialized)) continue;
    if (!fs.existsSync(materialized)) continue;
    await fs.promises.rm(materialized, { recursive: true, force: true });
    removedPaths.push(materialized);
  }

  return { slug: safeSlug, removedPaths };
}

async function syncLocalVaultAgentContexts() {
  const root = vaultDesignsRoot();
  const importResult = await importVaultDesignsIntoEmbeddedCatalog(root);
  const designs = await listLocalVaultDesignsForClient();
  const response = {
    mode: externalVaultEnabled() ? 'external' : 'embedded',
    designsRoot: root,
    importSourceRoot: importResult.sourceRoot,
    importAvailable: importResult.available,
    imported: importResult.imported,
    refreshed: importResult.refreshed,
    skippedImports: importResult.skipped,
    total: designs.length,
    synced: 0,
    failed: 0,
    skillPackages: 0,
    promptContexts: 0,
    downloadNeeded: designs.length === 0,
    downloadAvailable: false,
    message: designs.length === 0
      ? 'No local Design Vault catalog was found. A download channel will be added here later.'
      : 'Local Design Vault catalog is ready to sync into SFA skills and design systems.',
    items: [],
    errors: [...importResult.errors],
  };
  if (designs.length === 0) {
    response.message = 'No local Design Vault templates were synced. SFA no longer auto-imports templates from sibling projects.';
  }
  if (designs.length === 0) return response;

  for (const design of designs) {
    const slug = cleanString(design?.slug);
    if (!slug) {
      response.failed += 1;
      response.errors.push('Skipped a Design Vault item without a slug.');
      continue;
    }
    try {
      const context =
        (await loadVaultAgentContextFromLocalSlug(slug)) ??
        (await normalizeVaultAgentContext(design, { root: path.join(root, slug) }));
      if (!context) {
        response.failed += 1;
        response.errors.push(`Unable to resolve Design Vault context for ${slug}.`);
        continue;
      }
      const materialized = await materializeVaultAgentContext(context, {
        skillsDir: SKILLS_DIR,
        designSystemsDir: DESIGN_SYSTEMS_DIR,
      });
      const usable = Boolean(materialized.skillId || materialized.designSystemId);
      if (!usable) {
        response.failed += 1;
        response.errors.push(
          `${context.title || slug} did not produce an SFA skill or design system.`,
        );
      } else {
        response.synced += 1;
        if (context.kind === 'skill-package') response.skillPackages += 1;
        if (context.kind === 'prompt-context') response.promptContexts += 1;
      }
      response.items.push({
        slug: context.slug,
        title: context.title,
        kind: context.kind,
        packageType: context.packageType,
        skillId: materialized.skillId,
        designSystemId: materialized.designSystemId,
        warnings: materialized.warnings ?? [],
      });
    } catch (error) {
      response.failed += 1;
      response.errors.push(
        `${slug}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const importSummary = importResult.sourceRoot
    ? `Imported ${importResult.imported} new and refreshed ${importResult.refreshed} from Design Vault. `
    : '';
  response.message = response.synced > 0
    ? `${importSummary}Synced ${response.synced} Design Vault item${response.synced === 1 ? '' : 's'} into SFA.`
    : 'No local Design Vault templates were synced. SFA no longer auto-imports templates from sibling projects.';
  response.downloadNeeded = response.synced === 0 && designs.length === 0;
  return response;
}

async function importVaultDesignsIntoEmbeddedCatalog(targetRoot) {
  const result = {
    available: false,
    sourceRoot: '',
    imported: 0,
    refreshed: 0,
    skipped: 0,
    errors: [],
  };
  const sourceRoot = findVaultImportSourceRoot(targetRoot);
  if (!sourceRoot) return result;

  result.available = true;
  result.sourceRoot = sourceRoot;
  await fs.promises.mkdir(targetRoot, { recursive: true });

  let entries = [];
  try {
    entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    result.errors.push(`Unable to read Design Vault source ${sourceRoot}: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = cleanString(entry.name);
    if (!slug || slug.startsWith('.')) {
      result.skipped += 1;
      continue;
    }
    const source = path.join(sourceRoot, slug);
    if (!hasUsableLocalVaultDesign(source, slug)) {
      result.skipped += 1;
      continue;
    }
    const target = path.join(targetRoot, slug);
    try {
      const existed = fs.existsSync(target);
      await fs.promises.cp(source, target, {
        recursive: true,
        force: true,
        errorOnExist: false,
        preserveTimestamps: true,
      });
      if (existed) {
        result.refreshed += 1;
      } else {
        result.imported += 1;
      }
    } catch (error) {
      result.errors.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function findVaultImportSourceRoot(targetRoot) {
  const configured = [
    process.env.OPENPPT_VAULT_IMPORT_DIR,
    process.env.DESIGN_VAULT_IMPORT_DIR,
    process.env.DESIGN_VAULT_DESIGNS_SOURCE_DIR,
  ];
  const legacyAutodiscoveryEnabled = ['1', 'true', 'yes'].includes(
    cleanString(process.env.OPENPPT_VAULT_IMPORT_AUTODISCOVER).toLowerCase(),
  );
  const legacyCandidates = legacyAutodiscoveryEnabled
    ? [
        path.resolve(PROJECT_ROOT, '..', 'design-vault', 'data', 'designs'),
        path.resolve(PROJECT_ROOT, '..', '..', 'design-vault', 'data', 'designs'),
      ]
    : [];
  const candidates = [
    ...configured,
    ...legacyCandidates,
  ]
    .map((candidate) => cleanString(candidate))
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  const target = path.resolve(targetRoot);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate === target) continue;
    if (!fs.existsSync(candidate)) continue;
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    return candidate;
  }
  return '';
}

function hasUsableLocalVaultDesign(root, slug) {
  if (!fs.existsSync(root)) return false;
  return Boolean(
    fs.existsSync(path.join(root, 'meta.json')) ||
      fs.existsSync(path.join(root, 'design.md')) ||
      fs.existsSync(path.join(root, 'open-slide-theme.md')) ||
      fs.existsSync(path.join(root, 'skill', 'SKILL.md')) ||
      localVaultPreviewPath(slug, 'card') ||
      localVaultPreviewPath(slug, 'ppt') ||
      localVaultPreviewPath(slug, 'web'),
  );
}

function filterVaultDesignsForQuery(designs, query) {
  const q = cleanString(query?.q || query?.search || query?.query).toLowerCase();
  const filtered = q
    ? designs.filter((design) => {
        const haystack = [
          design?.slug,
          design?.title,
          design?.sourceHost,
          design?.summary,
          design?.kind,
          design?.packageType,
          design?.profile?.archetype,
          ...(Array.isArray(design?.tags) ? design.tags : []),
          ...(Array.isArray(design?.profile?.toneTags) ? design.profile.toneTags : []),
          ...(Array.isArray(design?.profile?.useCaseTags) ? design.profile.useCaseTags : []),
        ].map(cleanString).join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : designs;
  return filtered.sort((a, b) => {
    const scoreA = Number(a?.profile?.qualityScore ?? a?.qualityScore ?? 0);
    const scoreB = Number(b?.profile?.qualityScore ?? b?.qualityScore ?? 0);
    if (Number.isFinite(scoreA) && Number.isFinite(scoreB) && scoreA !== scoreB) return scoreB - scoreA;
    return cleanString(a?.title).localeCompare(cleanString(b?.title));
  });
}

async function readLocalVaultFavoriteSlugs() {
  const favoritesPath = path.resolve(vaultDesignsRoot(), '..', 'favorites.json');
  try {
    const data = JSON.parse(await fs.promises.readFile(favoritesPath, 'utf8'));
    const rawSlugs = Array.isArray(data?.slugs) ? data.slugs : [];
    return new Set(rawSlugs.map(cleanString).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function readExternalVaultFavoriteSlugs() {
  if (!externalVaultEnabled()) await ensureExternalVaultForRequest();
  if (!externalVaultEnabled()) return null;
  try {
    const result = await fetchVaultJson('/api/favorites');
    if (!result.ok) return null;
    const rawSlugs = Array.isArray(result.json?.slugs) ? result.json.slugs : [];
    return new Set(rawSlugs.map(cleanString).filter(Boolean));
  } catch {
    return null;
  }
}

async function readVaultFavoriteSlugsForClient() {
  return (await readExternalVaultFavoriteSlugs()) ?? readLocalVaultFavoriteSlugs();
}

function markVaultDesignFavorites(designs, favoriteSlugs) {
  return designs.map((design) => ({
    ...design,
    favorite: favoriteSlugs.has(cleanString(design?.slug)),
  }));
}

function localVaultPreviewPath(slug, kind) {
  const safeSlug = cleanString(slug);
  if (!safeSlug) return null;
  const root = path.join(vaultDesignsRoot(), safeSlug);
  const candidates = kind === 'card'
    ? [
        path.join(root, 'previews', 'card.html'),
        path.join(root, 'STYLE_CARD.html'),
        path.join(root, 'previews', 'ppt.html'),
        path.join(root, 'previews', 'web.html'),
      ]
    : kind === 'ppt'
      ? [
          path.join(root, 'previews', 'ppt.html'),
          path.join(root, 'previews', 'card.html'),
          path.join(root, 'STYLE_CARD.html'),
          path.join(root, 'previews', 'web.html'),
        ]
      : [
          path.join(root, 'previews', 'web.html'),
          path.join(root, 'previews', 'card.html'),
          path.join(root, 'STYLE_CARD.html'),
          path.join(root, 'previews', 'ppt.html'),
        ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && isPathWithin(root, candidate)) return candidate;
  }
  return null;
}

function rewriteVaultPreviewHtml(html, slug) {
  const targetSlug = cleanString(slug);
  return String(html).replace(
    /(["'(])\/api\/designs\/([^/"')]+)\/asset\/([^"')\s]+)/g,
    (_match, quote, rawSlug, rawAssetPath) => {
      const assetPathPart = decodeURIComponentSafe(String(rawAssetPath)).split(/[?#]/)[0]?.replace(/^\/+/, '') || '';
      const assetPath = assetPathPart.startsWith('assets/')
        ? assetPathPart
        : `assets/${assetPathPart}`;
      return `${quote}/api/vault/designs/${encodeURIComponent(targetSlug || cleanString(rawSlug))}/asset?path=${encodeURIComponent(assetPath)}`;
    },
  );
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function sendLocalVaultPreview(slug, kind, res) {
  const target = localVaultPreviewPath(slug, kind);
  if (!target) return false;
  const html = await fs.promises.readFile(target, 'utf8');
  res
    .status(200)
    .set('content-type', 'text/html; charset=utf-8')
    .set('cache-control', 'no-store')
    .send(rewriteVaultPreviewHtml(html, slug));
  return true;
}

function sendFallbackVaultPreview(slug, kind, res) {
  const safeSlug = cleanString(slug) || 'unknown-template';
  const safeKind = cleanString(kind) || 'preview';
  const title = escapeHtml(safeSlug);
  const label = escapeHtml(safeKind.toUpperCase());
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      html,body{margin:0;width:100%;height:100%;background:#181614;color:#f6efe7;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
      body{display:grid;place-items:center;}
      .card{box-sizing:border-box;width:min(92vw,920px);aspect-ratio:16/9;border:1px solid rgba(232,122,78,.38);border-radius:18px;background:linear-gradient(135deg,#211b17,#11100e);padding:clamp(18px,5vw,52px);display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 24px 80px rgba(0,0,0,.32);}
      .eyebrow{font-size:clamp(10px,2vw,18px);letter-spacing:.22em;text-transform:uppercase;color:#e87a4e;}
      h1{margin:0;font-size:clamp(28px,8vw,84px);line-height:.95;max-width:12ch;overflow-wrap:anywhere;}
      p{margin:0;color:#a9a19a;font-size:clamp(13px,2.4vw,22px);max-width:42ch;}
    </style>
  </head>
  <body>
    <section class="card">
      <div class="eyebrow">SFA · Design Vault · ${label}</div>
      <h1>${title}</h1>
      <p>This embedded template is missing a rendered preview file. Its context can still be used if design.md, open-slide-theme.md, or SKILL.md exists.</p>
    </section>
  </body>
</html>`;
  res
    .status(200)
    .set('content-type', 'text/html; charset=utf-8')
    .set('cache-control', 'no-store')
    .send(html);
  return true;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function vaultSlugFromDesignSystemId(designSystemId) {
  const value = cleanString(designSystemId);
  if (!value.startsWith('dv-')) return '';
  return value.slice(3);
}

async function vaultContextFromMetadataOrDesignSystem(metadata, designSystemId) {
  const vaultSlug = metadata?.vaultTemplate?.slug ?? vaultSlugFromDesignSystemId(designSystemId);
  if (vaultSlug) {
    const local = await loadVaultAgentContextFromLocalSlug(vaultSlug);
    if (local) return local;
  }
  return metadata?.vaultTemplate
    ? await normalizeVaultAgentContext(metadata.vaultTemplate)
    : null;
}

async function metadataWithVaultTemplateFromDesignSystem(metadata, designSystemId) {
  if (metadata?.kind !== 'deck' || metadata?.vaultTemplate) return metadata;
  const slug = vaultSlugFromDesignSystemId(designSystemId);
  if (!slug) return metadata;
  const design = await loadLocalVaultDesignForClient(slug);
  if (design) {
    const vaultTemplate = await vaultTemplateMetadataFromDesign(design);
    if (vaultTemplate?.slug) return { ...metadata, vaultTemplate };
  }
  const context = await loadVaultAgentContextFromLocalSlug(slug);
  if (!context) return metadata;
  return {
    ...metadata,
    vaultTemplate: {
      slug: context.slug,
      title: context.title,
      kind: context.kind,
      packageType: context.packageType,
      summary: context.summary,
      tags: context.tags,
      previewImage: localPreviewUrlForVaultContext(context),
      manifestPath: context.manifestPath,
      capabilitiesPath: context.capabilitiesPath,
      skillPath: context.skillPath,
      designPath: context.designPath,
      openSlideThemePath: context.openSlideThemePath,
      tokensPath: context.tokensPath,
      tokenStylesheet: context.tokenStylesheet,
      profilePath: context.profilePath,
      references: context.references,
      activationPrompt: context.activationPrompt,
    },
  };
}

async function readVaultOpenSlideTheme(metadata, designSystemId) {
  const localContext = await vaultContextFromMetadataOrDesignSystem(metadata, designSystemId);
  const raw = localContext?.openSlideThemePath ?? metadata?.vaultTemplate?.openSlideThemePath;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const resolved = path.resolve(raw);
  if (path.basename(resolved) !== 'open-slide-theme.md') return undefined;
  try {
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile() || stat.size > 256 * 1024) return undefined;
    return await fs.promises.readFile(resolved, 'utf8');
  } catch {
    return undefined;
  }
}

async function readVaultTokenStylesheet(metadata, designSystemId) {
  if (metadata?.kind !== 'deck') return undefined;
  const context = await vaultContextFromMetadataOrDesignSystem(metadata, designSystemId);
  return cleanString(context?.tokenStylesheet) || cleanString(metadata?.vaultTemplate?.tokenStylesheet) || undefined;
}

async function readVaultAgentContextBody(metadata, designSystemId) {
  if (metadata?.kind !== 'deck') return undefined;
  const context = await vaultContextFromMetadataOrDesignSystem(metadata, designSystemId);
  const prompt = await buildVaultAgentContextPrompt(context);
  return prompt?.body;
}

async function readVaultContextAttachmentsBody(items) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const sections = [
    '## User-selected Design Vault contexts for this turn',
    '',
    'The user attached the following Design Vault design systems / skills from the composer. Treat them as turn-scoped authoritative context. If a selected item is a skill-package, follow it like an active skill before generating or editing. If it is prompt-context, follow its DESIGN.md / open-slide-theme / tokens / profile as design-system context.',
  ];
  for (const item of items) {
    try {
      const local = await loadVaultAgentContextFromLocalSlug(item.slug);
      const context = local ?? (await normalizeVaultAgentContext(item));
      if (!context) {
        sections.push('', `### ${item.slug}`, `Warning: unable to resolve Design Vault context "${item.slug}".`);
        continue;
      }
      const materialized =
        context.kind === 'skill-package'
          ? await materializeVaultAgentContext(context, {
              skillsDir: SKILLS_DIR,
              designSystemsDir: DESIGN_SYSTEMS_DIR,
            })
          : null;
      const prompt = await buildVaultAgentContextPrompt(context);
      sections.push('', `### Attached: ${context.title}`);
      if (materialized?.skillId) {
        sections.push(
        `Materialized SFA skill id: ${materialized.skillId}`,
          `Materialized skill directory: ${path.join(SKILLS_DIR, materialized.skillId)}`,
        );
      }
      if (materialized?.warnings?.length) {
        sections.push('Materialization warnings:', ...materialized.warnings.map((warning) => `- ${warning}`));
      }
      sections.push(prompt?.body ?? `Warning: ${context.slug} resolved but no context files were readable.`);
    } catch (error) {
      sections.push(
        '',
        `### ${item.slug}`,
        `Warning: failed to load Design Vault context: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return sections.join('\n');
}

async function readVaultCatalogForPrompt(metadata) {
  if (metadata?.kind !== 'deck' || metadata?.vaultTemplate) return undefined;
  try {
    let raw = await listLocalVaultDesignsForClient();
    if (raw.length === 0 && externalVaultEnabled()) {
      const result = await fetchVaultJson('/api/designs');
      if (!result.ok) return undefined;
      raw = Array.isArray(result.json)
        ? result.json
        : Array.isArray(result.json?.designs)
          ? result.json.designs
          : [];
    }
    const designs = filterVaultDesignsForQuery(
      raw.filter((design) => design && typeof design === 'object'),
      {},
    ).slice(0, 16);
    if (designs.length === 0) return undefined;
    const enriched = await Promise.all(designs.map((design) => enrichVaultDesignForClient(design)));
    return enriched.map((design, index) => {
      const profile = design.profile && typeof design.profile === 'object' ? design.profile : {};
      const colorRoles = profile.colorRoles && typeof profile.colorRoles === 'object'
        ? profile.colorRoles
        : {};
      const guidance = profile.openSlideGuidance && typeof profile.openSlideGuidance === 'object'
        ? profile.openSlideGuidance
        : {};
      const parts = [
        `${index + 1}. ${cleanString(design.title) || cleanString(design.slug) || 'Untitled template'}`,
        `slug: ${cleanString(design.slug) || 'unknown'}`,
        cleanString(design.kind) ? `kind: ${cleanString(design.kind)}` : null,
        cleanString(design.packageType) ? `packageType: ${cleanString(design.packageType)}` : null,
        cleanString(design.sourceHost) ? `source: ${cleanString(design.sourceHost)}` : null,
        cleanString(profile.archetype) ? `archetype: ${cleanString(profile.archetype)}` : null,
        cleanString(profile.visualThesis) ? `visualThesis: ${cleanString(profile.visualThesis)}` : null,
        Array.isArray(profile.toneTags) && profile.toneTags.length > 0
          ? `toneTags: ${profile.toneTags.map(cleanString).filter(Boolean).slice(0, 8).join(', ')}`
          : null,
        Array.isArray(profile.useCaseTags) && profile.useCaseTags.length > 0
          ? `useCases: ${profile.useCaseTags.map(cleanString).filter(Boolean).slice(0, 8).join(', ')}`
          : null,
        Array.isArray(profile.audienceFit) && profile.audienceFit.length > 0
          ? `audienceFit: ${profile.audienceFit.map(cleanString).filter(Boolean).slice(0, 6).join(', ')}`
          : null,
        typeof profile.contentDensity === 'string'
          ? `contentDensity: ${cleanString(profile.contentDensity)}`
          : profile.contentDensity && typeof profile.contentDensity === 'object'
            ? `contentDensity: ${cleanString(profile.contentDensity.level) || '?'}${cleanString(profile.contentDensity.rationale) ? ` (${cleanString(profile.contentDensity.rationale)})` : ''}`
            : null,
        Array.isArray(profile.narrativeFit) && profile.narrativeFit.length > 0
          ? `narrativeFit: ${profile.narrativeFit.map(cleanString).filter(Boolean).slice(0, 6).join(', ')}`
          : null,
        typeof profile.mediaPromptGrammar === 'string' && cleanString(profile.mediaPromptGrammar)
          ? `mediaPromptGrammar: ${cleanString(profile.mediaPromptGrammar)}`
          : Array.isArray(profile.mediaPromptGrammar) && profile.mediaPromptGrammar.length > 0
            ? `mediaPromptGrammar: ${profile.mediaPromptGrammar.map(cleanString).filter(Boolean).slice(0, 4).join(' / ')}`
            : null,
        cleanString(design.summary) ? `summary: ${cleanString(design.summary)}` : null,
        Array.isArray(profile.matchingRationale) && profile.matchingRationale.length > 0
          ? `matchingRationale: ${profile.matchingRationale.map(cleanString).filter(Boolean).slice(0, 3).join(' / ')}`
          : null,
        Array.isArray(profile.avoidWhen) && profile.avoidWhen.length > 0
          ? `avoidWhen: ${profile.avoidWhen.map(cleanString).filter(Boolean).slice(0, 4).join(' / ')}`
          : null,
        cleanString(guidance.direction) ? `slideDirection: ${cleanString(guidance.direction)}` : null,
        cleanString(guidance.coverApproach) ? `cover: ${cleanString(guidance.coverApproach)}` : null,
        Array.isArray(guidance.layoutApproach) && guidance.layoutApproach.length > 0
          ? `layout: ${guidance.layoutApproach.map(cleanString).filter(Boolean).slice(0, 4).join(' / ')}`
          : null,
        Array.isArray(guidance.motionApproach) && guidance.motionApproach.length > 0
          ? `motion: ${guidance.motionApproach.map(cleanString).filter(Boolean).slice(0, 3).join(' / ')}`
          : null,
        compactMotionRecipeSummary(profile.componentMotionRecipes)
          ? `motionRecipes: ${compactMotionRecipeSummary(profile.componentMotionRecipes)}`
          : null,
        cleanString(colorRoles.background) || cleanString(colorRoles.text) || cleanString(colorRoles.brandPrimary)
          ? `colors: bg ${cleanString(colorRoles.background) || '?'}, text ${cleanString(colorRoles.text) || '?'}, primary ${cleanString(colorRoles.brandPrimary) || '?'}`
          : null,
        cleanString(design.openSlideThemePath) ? `openSlideThemePath: ${cleanString(design.openSlideThemePath)}` : null,
        cleanString(design.skillPath) ? `skillPath: ${cleanString(design.skillPath)}` : null,
        cleanString(design.capabilitiesPath) ? `capabilitiesPath: ${cleanString(design.capabilitiesPath)}` : null,
        Array.isArray(design.references) && design.references.length > 0
          ? `references: ${design.references.map(cleanString).filter(Boolean).slice(0, 8).join(', ')}`
          : null,
      ].filter(Boolean);
      return `- ${parts.join(' | ')}`;
    }).join('\n');
  } catch {
    return undefined;
  }
}

function mergeOpenPptDesign(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const next = { ...(base && typeof base === 'object' ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      next[key] &&
      typeof next[key] === 'object' &&
      !Array.isArray(next[key])
    ) {
      next[key] = mergeOpenPptDesign(next[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function applyLineEdits(source, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return source;
  const lines = source.split('\n');
  const normalized = edits
    .map((edit) => {
      const startLine = Number(edit?.startLine);
      const endLine = Number(edit?.endLine ?? edit?.startLine);
      const replacement =
        typeof edit?.replacement === 'string' ? edit.replacement : '';
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
      if (startLine < 1 || endLine < startLine || startLine > lines.length + 1) {
        return null;
      }
      return {
        start: startLine - 1,
        deleteCount: Math.max(0, Math.min(endLine, lines.length) - startLine + 1),
        replacementLines: replacement.length ? replacement.split('\n') : [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.start - a.start);
  for (const edit of normalized) {
    lines.splice(edit.start, edit.deleteCount, ...edit.replacementLines);
  }
  return lines.join('\n');
}

const OPENPPT_UNITLESS_STYLE_KEYS = new Set([
  'fontWeight',
  'lineHeight',
  'opacity',
  'zIndex',
  'flex',
  'flexGrow',
  'flexShrink',
]);

function spliceSource(source, start, end, replacement) {
  return source.slice(0, start) + replacement + source.slice(end);
}

function jsStyleLiteral(key, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const raw = String(value);
  if (OPENPPT_UNITLESS_STYLE_KEYS.has(key) && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return String(Number(raw));
  }
  return JSON.stringify(raw);
}

function jsxOpeningFromNode(ts, node) {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return null;
}

function findOpenPptJsxTarget(ts, sourceFile, line, column) {
  let exact = null;
  let sameLine = null;
  function visit(node) {
    const opening = jsxOpeningFromNode(ts, node);
    if (opening) {
      const tagName = opening.tagName;
      const isTaggable =
        tagName &&
        ts.isIdentifier(tagName) &&
        (/^[a-z]/.test(tagName.text) || tagName.text === 'ImagePlaceholder');
      if (isTaggable) {
        const pos = node.getStart(sourceFile);
        const loc = sourceFile.getLineAndCharacterOfPosition(pos);
        const hit = {
          node,
          opening,
          line: loc.line + 1,
          column: loc.character,
        };
        if (hit.line === line && hit.column === column) {
          exact = hit;
        } else if (hit.line === line) {
          if (!sameLine || Math.abs(hit.column - column) < Math.abs(sameLine.column - column)) {
            sameLine = hit;
          }
        }
      }
    }
    if (!exact) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return exact ?? sameLine;
}

function propNameText(ts, name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return String(name.text);
  }
  return null;
}

function findStyleAttr(ts, opening) {
  return opening.attributes.properties.find(
    (attr) => ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === 'style',
  );
}

function propertyRemovalRange(sourceFile, objectLiteral, prop) {
  const properties = Array.from(objectLiteral.properties);
  const index = properties.indexOf(prop);
  if (index < 0) return { start: prop.getStart(sourceFile), end: prop.end };
  const prev = properties[index - 1];
  const next = properties[index + 1];
  if (prev) {
    return { start: prev.end, end: prop.end };
  }
  if (next) {
    return { start: prop.getStart(sourceFile), end: next.getStart(sourceFile) };
  }
  return { start: prop.getStart(sourceFile), end: prop.end };
}

function applyStyleObjectEdit(ts, source, sourceFile, objectLiteral, key, value) {
  const literal = jsStyleLiteral(key, value);
  const prop = objectLiteral.properties.find((item) => (
    ts.isPropertyAssignment(item) && propNameText(ts, item.name) === key
  ));
  if (prop && ts.isPropertyAssignment(prop)) {
    if (literal === null) {
      const range = propertyRemovalRange(sourceFile, objectLiteral, prop);
      return spliceSource(source, range.start, range.end, '');
    }
    return spliceSource(source, prop.initializer.getStart(sourceFile), prop.initializer.end, literal);
  }
  if (literal === null) return source;
  const hasProps = objectLiteral.properties.length > 0;
  const insertAt = hasProps
    ? objectLiteral.properties[objectLiteral.properties.length - 1].end
    : objectLiteral.end - 1;
  const insertion = `${hasProps ? ', ' : ''}${key}: ${literal}`;
  return spliceSource(source, insertAt, insertAt, insertion);
}

function applyOpenPptStyleEdit(ts, source, sourceFile, opening, key, value) {
  const literal = jsStyleLiteral(key, value);
  const styleAttr = findStyleAttr(ts, opening);
  if (!styleAttr) {
    if (literal === null) return source;
    return spliceSource(source, opening.tagName.end, opening.tagName.end, ` style={{ ${key}: ${literal} }}`);
  }
  const initializer = styleAttr.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
    if (literal === null) return source;
    return spliceSource(source, styleAttr.getStart(sourceFile), styleAttr.end, `style={{ ${key}: ${literal} }}`);
  }
  const expression = initializer.expression;
  if (ts.isObjectLiteralExpression(expression)) {
    return applyStyleObjectEdit(ts, source, sourceFile, expression, key, value);
  }
  if (literal === null) return source;
  const expressionText = source.slice(expression.getStart(sourceFile), expression.end);
  return spliceSource(
    source,
    styleAttr.getStart(sourceFile),
    styleAttr.end,
    `style={{ ...(${expressionText}), ${key}: ${literal} }}`,
  );
}

function applyOpenPptTextEdit(ts, source, sourceFile, node, value) {
  if (!ts.isJsxElement(node)) return source;
  const start = node.openingElement.end;
  const end = node.closingElement.getStart(sourceFile);
  return spliceSource(source, start, end, `{${JSON.stringify(String(value ?? ''))}}`);
}

export async function applyOpenPptEditBatch(source, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { source, changed: false, results: [] };
  }
  const ts = await import('typescript');
  let nextSource = source;
  const results = [];
  for (const edit of edits) {
    const line = Number(edit?.line);
    const column = Number(edit?.column);
    const ops = Array.isArray(edit?.ops) ? edit.ops : [];
    if (!Number.isInteger(line) || !Number.isInteger(column) || ops.length === 0) {
      results.push({ ok: false, error: 'invalid edit target' });
      continue;
    }
    const beforeEdit = nextSource;
    try {
      for (const op of ops) {
        const sourceFile = ts.createSourceFile(
          'index.tsx',
          nextSource,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );
        const target = findOpenPptJsxTarget(ts, sourceFile, line, column);
        if (!target) throw new Error(`target ${line}:${column} not found`);
        if (op?.kind === 'set-style') {
          const key = cleanString(op.key);
          if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) throw new Error('invalid style key');
          nextSource = applyOpenPptStyleEdit(ts, nextSource, sourceFile, target.opening, key, op.value ?? null);
        } else if (op?.kind === 'set-text') {
          nextSource = applyOpenPptTextEdit(ts, nextSource, sourceFile, target.node, op.value);
        } else {
          throw new Error(`unsupported edit op: ${op?.kind}`);
        }
      }
      results.push({ ok: true, changed: nextSource !== beforeEdit });
    } catch (err) {
      results.push({ ok: false, error: String(err?.message || err) });
      nextSource = beforeEdit;
    }
  }
  if (nextSource !== source) {
    const compiled = await compileOpenPptSlideModule(nextSource);
    if (compiled.diagnostics.length > 0) {
      return {
        source,
        changed: false,
        results: [
          ...results,
          {
            ok: false,
            error: `edit produced invalid TSX: ${compiled.diagnostics
              .map((diagnostic) => diagnostic.message)
              .filter(Boolean)
              .join(' · ')}`,
          },
        ],
        diagnostics: compiled.diagnostics,
      };
    }
  }
  return { source: nextSource, changed: nextSource !== source, results };
}

function openPptCompilerDiagnostics(diagnostics) {
  return (diagnostics || [])
    .filter((diagnostic) => diagnostic?.messageText)
    .map((diagnostic) => {
      const message =
        typeof diagnostic.messageText === 'string'
          ? diagnostic.messageText
          : diagnostic.messageText.messageText;
      return {
        code: diagnostic.code,
        category: diagnostic.category,
        message: String(message || ''),
      };
    });
}

function injectOpenPptLocTags(ts, source) {
  const sourceFile = ts.createSourceFile(
    'index.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const insertions = [];

  function openingFromNode(node) {
    if (ts.isJsxElement(node)) return node.openingElement;
    if (ts.isJsxSelfClosingElement(node)) return node;
    return null;
  }

  function taggableName(opening) {
    const tagName = opening?.tagName;
    if (!tagName || !ts.isIdentifier(tagName)) return false;
    return /^[a-z]/.test(tagName.text) || tagName.text === 'ImagePlaceholder';
  }

  function alreadyTagged(opening) {
    return opening.attributes.properties.some(
      (attr) =>
        ts.isJsxAttribute(attr) &&
        ts.isIdentifier(attr.name) &&
        attr.name.text === 'data-slide-loc',
    );
  }

  function visit(node) {
    const opening = openingFromNode(node);
    if (opening && taggableName(opening) && !alreadyTagged(opening)) {
      const tagName = opening.tagName;
      const pos = node.getStart(sourceFile);
      const loc = sourceFile.getLineAndCharacterOfPosition(pos);
      insertions.push({
        offset: tagName.end,
        text: ` data-slide-loc="${loc.line + 1}:${loc.character}"`,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (insertions.length === 0) return source;
  insertions.sort((a, b) => b.offset - a.offset);
  let next = source;
  for (const insertion of insertions) {
    next = next.slice(0, insertion.offset) + insertion.text + next.slice(insertion.offset);
  }
  return next;
}

async function compileOpenPptSlideModule(source) {
  const ts = await import('typescript');
  const taggedSource = injectOpenPptLocTags(ts, source);
  const result = ts.transpileModule(taggedSource, {
    fileName: 'index.tsx',
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      isolatedModules: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  });
  return {
    code: result.outputText,
    diagnostics: openPptCompilerDiagnostics(result.diagnostics),
  };
}

function resolveProcessResourcesPath() {
  if (
    typeof process.resourcesPath === 'string' &&
    process.resourcesPath.length > 0
  ) {
    return process.resourcesPath;
  }

  // Packaged daemon sidecars run under the bundled Node binary rather than the
  // Electron root process, so `process.resourcesPath` is unavailable there.
  // Infer the macOS app Resources directory from that bundled Node path.
  const resourcesMarker = `${path.sep}Contents${path.sep}Resources${path.sep}`;
  const markerIndex = process.execPath.indexOf(resourcesMarker);
  if (markerIndex !== -1) {
    return process.execPath.slice(0, markerIndex + resourcesMarker.length - 1);
  }

  const normalizedExecPath = process.execPath.toLowerCase();
  const windowsResourceBinMarker =
    `${path.sep}resources${path.sep}open-design${path.sep}bin${path.sep}`.toLowerCase();
  const windowsMarkerIndex = normalizedExecPath.indexOf(
    windowsResourceBinMarker,
  );
  if (windowsMarkerIndex !== -1) {
    return process.execPath.slice(
      0,
      windowsMarkerIndex + `${path.sep}resources`.length,
    );
  }

  return null;
}

export function resolveDaemonResourceRoot({
  configured = process.env[RESOURCE_ROOT_ENV],
  safeBases = [PROJECT_ROOT, resolveProcessResourcesPath()],
} = {}) {
  if (!configured || configured.length === 0) return null;

  const resolved = path.resolve(configured);
  const normalizedSafeBases = safeBases
    .filter((base) => typeof base === 'string' && base.length > 0)
    .map((base) => path.resolve(base));

  if (!normalizedSafeBases.some((base) => isPathWithin(base, resolved))) {
    throw new Error(
      `${RESOURCE_ROOT_ENV} must be under the workspace root or app resources path`,
    );
  }

  return resolved;
}

function resolveDaemonResourceDir(resourceRoot, segment, fallback) {
  return resourceRoot ? path.join(resourceRoot, segment) : fallback;
}

const DAEMON_RESOURCE_ROOT = resolveDaemonResourceRoot();
// Built web app lives in `out/` — that's where Next.js writes the static
// export configured in next.config.ts. The folder name used to be `dist/`
// when this project shipped with Vite; the daemon serves whatever the
// frontend toolchain emits, no further config needed.
const STATIC_DIR = path.join(PROJECT_ROOT, 'apps', 'web', 'out');
const OD_BIN = resolveDaemonCliPath();
const OD_NODE_BIN = process.execPath;
const SKILLS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'skills',
  path.join(PROJECT_ROOT, 'skills'),
);
const DESIGN_SYSTEMS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'design-systems',
  path.join(PROJECT_ROOT, 'design-systems'),
);
const CRAFT_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'craft',
  path.join(PROJECT_ROOT, 'craft'),
);
const FRAMES_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'frames',
  path.join(PROJECT_ROOT, 'assets', 'frames'),
);
const PROMPT_TEMPLATES_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'prompt-templates',
  path.join(PROJECT_ROOT, 'prompt-templates'),
);
export function resolveDataDir(raw, projectRoot) {
  if (!raw) return path.join(projectRoot, '.od');
  const expanded = raw.startsWith('~/')
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
  const resolved = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(projectRoot, expanded);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch (err) {
    const e = err;
    throw new Error(
      `OD_DATA_DIR "${resolved}" is not writable: ${e.message}`,
    );
  }
  return resolved;
}
const RUNTIME_DATA_DIR = resolveDataDir(process.env.OD_DATA_DIR, PROJECT_ROOT);
const ARTIFACTS_DIR = path.join(RUNTIME_DATA_DIR, 'artifacts');
const PROJECTS_DIR = path.join(RUNTIME_DATA_DIR, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

const activeChatAgentEventSinks = new Map();
const activeProjectEventSinks = new Map();

function emitChatAgentEvent(runId, payload) {
  const sink = activeChatAgentEventSinks.get(runId);
  if (!sink) return false;
  return sink(payload);
}

function emitLiveArtifactEvent(grant, action, artifact) {
  if (!artifact?.id) return false;
  const payload = {
    type: 'live_artifact',
    action,
    projectId: artifact.projectId ?? grant.projectId,
    artifactId: artifact.id,
    title: artifact.title ?? artifact.id,
    refreshStatus: artifact.refreshStatus,
  };
  let emitted = emitProjectLiveArtifactEvent(payload.projectId, payload);
  if (grant?.runId) emitted = emitChatAgentEvent(grant.runId, payload) || emitted;
  return emitted;
}

function emitLiveArtifactRefreshEvent(grant, payload) {
  if (!payload?.artifactId) return false;
  const event = {
    type: 'live_artifact_refresh',
    projectId: grant.projectId,
    ...payload,
  };
  let emitted = emitProjectLiveArtifactEvent(grant.projectId, event);
  if (grant?.runId) emitted = emitChatAgentEvent(grant.runId, event) || emitted;
  return emitted;
}

function emitProjectLiveArtifactEvent(projectId, payload) {
  const sinks = activeProjectEventSinks.get(projectId);
  if (!sinks || sinks.size === 0) return false;
  for (const sink of Array.from(sinks)) {
    try {
      sink(payload);
    } catch {
      sinks.delete(sink);
    }
  }
  if (sinks.size === 0) activeProjectEventSinks.delete(projectId);
  return true;
}

// Windows ENAMETOOLONG mitigation constants
const CMD_BAT_RE = /\.(cmd|bat)$/i;
const PROMPT_TEMP_FILE = () =>
  '.od-prompt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.md';
const promptFileBootstrap = (fp) =>
  `Your full instructions are stored in the file: ${fp.replace(/\\/g, '/')}. ` +
  'Open that file first and follow every instruction in it exactly — ' +
  'it contains the system prompt, design system, skill workflow, and user request. ' +
  'Do not begin your response until you have read the entire file.';

// Load Critique Theater config once at startup so a bad OD_CRITIQUE_* value
// surfaces immediately as a boot-time RangeError instead of silently at
// run time. Default: enabled=false (M0 dark launch).
const critiqueCfg = loadCritiqueConfigFromEnv();
// Tracks adapter streamFormat values that have already received a one-time
// warning explaining why the Critique Theater orchestrator was bypassed.
// Adapter denylist for orchestrator routing is implicit: anything that is
// not the 'plain' streamFormat falls through to legacy single-pass.
const critiqueWarnedAdapters = new Set<string>();
export const SSE_KEEPALIVE_INTERVAL_MS = 25_000;
const CHAT_RUN_IDLE_TIMEOUT_MS = readPositiveIntegerEnv(
  process.env.OD_CHAT_RUN_IDLE_TIMEOUT_MS,
  10 * 60 * 1000,
);
const CHAT_RUN_CANCEL_GRACE_MS = readPositiveIntegerEnv(
  process.env.OD_CHAT_RUN_CANCEL_GRACE_MS,
  3 * 1000,
);

function readPositiveIntegerEnv(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function createAgentRuntimeEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  daemonUrl: string,
  toolTokenGrant: { token?: string } | null = null,
  nodeBin: string = process.execPath,
): NodeJS.ProcessEnv {
  const env = {
    ...baseEnv,
    OD_DAEMON_URL: daemonUrl,
    OD_NODE_BIN: nodeBin,
  };

  if (toolTokenGrant?.token) {
    env.OD_TOOL_TOKEN = toolTokenGrant.token;
  } else {
    delete env.OD_TOOL_TOKEN;
  }

  return env;
}

export function createAgentRuntimeToolPrompt(
  daemonUrl: string,
  toolTokenGrant: { token?: string } | null = null,
): string {
  const tokenLine = toolTokenGrant?.token
    ? '- `OD_TOOL_TOKEN` is available in your environment for this run. Use it only through project wrapper commands; do not print, persist, or override it.'
    : '- `OD_TOOL_TOKEN` is not available for this run, so `/api/tools/*` wrapper commands may be unavailable.';

  return [
    '## Runtime tool environment',
    '',
    `- Daemon URL: \`${daemonUrl}\` (also available as \`OD_DAEMON_URL\`).`,
    '- `OD_NODE_BIN` is the absolute path to the Node-compatible runtime that started the daemon; packaged desktop installs provide this even when the user has no system `node` on PATH.',
    '- `OD_BIN` is the absolute path to the Open Design CLI script. On POSIX shells run wrappers with `"$OD_NODE_BIN" "$OD_BIN" tools ...`; do not call bare `od`, which may resolve to the system octal-dump command on Unix-like systems.',
    '- On PowerShell use `& $env:OD_NODE_BIN $env:OD_BIN tools ...`; on cmd.exe use `"%OD_NODE_BIN%" "%OD_BIN%" tools ...`.',
    tokenLine,
    '- Prefer project wrapper commands through `OD_NODE_BIN` + `OD_BIN` over raw HTTP. The wrappers read these environment values automatically.',
    '- Do not run long-lived dev servers, file watchers, or preview commands in the foreground. If a server is needed, start it in the background or with a bounded timeout, verify readiness, report the URL, and then let the turn finish.',
  ].join('\n');
}

export function normalizeProjectDisplayStatus(status) {
  return status === 'starting' || status === 'queued' ? 'running' : status;
}

export function composeProjectDisplayStatus(
  baseStatus,
  awaitingInputProjects,
  projectId,
) {
  if (
    baseStatus.value === 'succeeded' &&
    awaitingInputProjects.has(projectId)
  ) {
    return { ...baseStatus, value: 'awaiting_input' };
  }
  return {
    ...baseStatus,
    value: normalizeProjectDisplayStatus(baseStatus.value),
  };
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 * @returns {ApiError}
 */
export function createCompatApiError(code, message, init = {}) {
  return { code, message, ...init };
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 * @returns {ApiErrorResponse}
 */
export function createCompatApiErrorResponse(code, message, init = {}) {
  return { error: createCompatApiError(code, message, init) };
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 */
function sendApiError(res, status, code, message, init = {}) {
  return res
    .status(status)
    .json(createCompatApiErrorResponse(code, message, init));
}

// Filename slug for the Content-Disposition header on archive downloads.
// Browsers reject quotes and control bytes; we keep Unicode letters/digits
// so a project name with non-ASCII characters (e.g. "café-design")
// survives instead of becoming a row of underscores.
function sanitizeArchiveFilename(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned;
}

function sendLiveArtifactRouteError(res, err) {
  if (err instanceof LiveArtifactStoreValidationError) {
    return sendApiError(res, 400, 'LIVE_ARTIFACT_INVALID', err.message, {
      details: { kind: 'validation', issues: err.issues },
    });
  }
  if (err instanceof LiveArtifactRefreshLockError) {
    return sendApiError(res, 409, 'REFRESH_LOCKED', err.message, {
      details: { artifactId: err.artifactId },
    });
  }
  if (err instanceof LiveArtifactRefreshUnavailableError) {
    return sendApiError(res, 400, 'LIVE_ARTIFACT_REFRESH_UNAVAILABLE', err.message);
  }
  if (err instanceof LiveArtifactRefreshAbortError) {
    return sendApiError(res, err.kind === 'cancelled' ? 499 : 504, 'LIVE_ARTIFACT_REFRESH_TIMEOUT', err.message, {
      details: { kind: err.kind, timeoutMs: err.timeoutMs ?? null, step: err.step ?? null },
    });
  }
  if (err instanceof ConnectorServiceError) {
    return sendApiError(res, err.status, err.code, err.message, err.details === undefined ? {} : { details: err.details });
  }
  if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
    return sendApiError(res, 404, 'LIVE_ARTIFACT_NOT_FOUND', 'live artifact not found');
  }
  return sendApiError(res, 500, 'LIVE_ARTIFACT_STORAGE_FAILED', String(err));
}

function normalizeLocalAuthority(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[\s/@]/.test(trimmed) || trimmed.includes(',')) return null;

  try {
    const parsed = new URL(`http://${trimmed}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || parsed.username || parsed.password || parsed.pathname !== '/') return null;
    return { hostname, port: parsed.port };
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (net.isIP(normalized) === 4) return normalized === '127.0.0.1' || normalized.startsWith('127.');
  return false;
}

function isLoopbackPeerAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return false;
  if (normalized.startsWith('::ffff:')) return isLoopbackPeerAddress(normalized.slice('::ffff:'.length));
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (net.isIP(normalized) === 4) return normalized === '127.0.0.1' || normalized.startsWith('127.');
  return false;
}

function localOriginFromHeader(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed.includes(',')) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    if (!isLoopbackHostname(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function validateLocalDaemonRequest(req) {
  if (!isLoopbackPeerAddress(req.socket?.remoteAddress)) {
    return {
      ok: false,
      message: 'request peer must be a loopback address',
      details: { peer: 'remoteAddress' },
    };
  }

  const host = normalizeLocalAuthority(req.get('host'));
  if (!host || !isLoopbackHostname(host.hostname)) {
    return {
      ok: false,
      message: 'request host must be a loopback daemon address',
      details: { header: 'host' },
    };
  }

  const originHeader = req.get('origin');
  if (originHeader !== undefined && !localOriginFromHeader(originHeader)) {
    return {
      ok: false,
      message: 'request origin must be a loopback daemon origin',
      details: { header: 'origin' },
    };
  }

  return { ok: true, origin: localOriginFromHeader(originHeader) };
}

function requireLocalDaemonRequest(req, res, next) {
  const validation = validateLocalDaemonRequest(req);
  if (!validation.ok) {
    return sendApiError(res, 403, 'FORBIDDEN', validation.message, validation.details ? { details: validation.details } : {});
  }

  res.setHeader('Vary', 'Origin');
  if (validation.origin) {
    res.setHeader('Access-Control-Allow-Origin', validation.origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  next();
}

function setLiveArtifactPreviewHeaders(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "base-uri 'none'",
      "script-src 'none'",
      "object-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'unsafe-inline'",
      'sandbox allow-same-origin',
    ].join('; '),
  );
}

function setLiveArtifactCodeHeaders(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function bearerTokenFromRequest(req) {
  const header = req.get('authorization');
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function authorizeToolRequest(req, res, operation) {
  const endpoint = req.path;
  const validation = toolTokenRegistry.validate(bearerTokenFromRequest(req), { endpoint, operation });
  if (!validation.ok) {
    const status = validation.code === 'TOOL_ENDPOINT_DENIED' || validation.code === 'TOOL_OPERATION_DENIED' ? 403 : 401;
    sendApiError(res, status, validation.code, validation.message, {
      details: { endpoint, operation },
    });
    return null;
  }
  return validation.grant;
}

function requestProjectOverride(projectId, tokenProjectId) {
  return typeof projectId === 'string' && projectId.length > 0 && projectId !== tokenProjectId;
}

function requestRunOverride(runId, tokenRunId) {
  return typeof runId === 'string' && runId.length > 0 && runId !== tokenRunId;
}

function openNativeFolderDialog() {
  return new Promise((resolve) => {
    const platform = process.platform;
    if (platform === 'darwin') {
      execFile(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Select a code folder to link")'],
        { timeout: 120_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const p = stdout.trim().replace(/\/$/, '');
          resolve(p || null);
        },
      );
    } else if (platform === 'linux') {
      execFile(
        'zenity',
        ['--file-selection', '--directory', '--title=Select a code folder to link'],
        { timeout: 120_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const p = stdout.trim();
          resolve(p || null);
        },
      );
    } else if (platform === 'win32') {
      const ps = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select a code folder to link'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }";
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 120_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const p = stdout.trim();
        resolve(p || null);
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 */
function createSseErrorPayload(code, message, init = {}) {
  return { message, error: createCompatApiError(code, message, init) };
}

const UPLOAD_DIR = path.join(os.tmpdir(), 'od-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`,
      );
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const importUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`,
      );
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Project-scoped multi-file upload. Lands files directly in the project
// folder (flat — same shape FileWorkspace expects), so the composer's
// pasted/dropped/picked images become referenceable filenames the agent
// can Read or @-mention without any cross-folder gymnastics.
const projectUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const dir = await ensureProject(PROJECTS_DIR, req.params.id);
        cb(null, dir);
      } catch (err) {
        cb(err, '');
      }
    },
    filename: (_req, file, cb) => {
      // multer@1 hands us latin1-decoded multipart filenames; restore the
      // original UTF-8 so the response (and the on-disk name) preserves
      // non-ASCII characters instead of mangling them. Then run the
      // shared sanitiser and prepend a base36 timestamp so multiple
      // uploads with the same original name don't clobber each other.
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(null, `${Date.now().toString(36)}-${safe}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },  // 200MB — covers the largest design assets we expect (PPTX/PDF/raw images)
});

function handleProjectUpload(req, res, next) {
  projectUpload.array('files', 12)(req, res, (err) => {
    if (err) {
      return sendMulterError(res, err);
    }
    next();
  });
}

function sendMulterError(res, err) {
  if (err instanceof multer.MulterError) {
    const code = err.code || 'UPLOAD_ERROR';
    const statusByCode = {
      LIMIT_FILE_SIZE: 413,
      LIMIT_FILE_COUNT: 400,
      LIMIT_UNEXPECTED_FILE: 400,
      LIMIT_PART_COUNT: 400,
      LIMIT_FIELD_KEY: 400,
      LIMIT_FIELD_VALUE: 400,
      LIMIT_FIELD_COUNT: 400,
    };
    const errorByCode = {
      LIMIT_FILE_SIZE: 'file too large',
      LIMIT_FILE_COUNT: 'too many files',
      LIMIT_UNEXPECTED_FILE: 'unexpected file field',
      LIMIT_PART_COUNT: 'too many form parts',
      LIMIT_FIELD_KEY: 'field name too long',
      LIMIT_FIELD_VALUE: 'field value too long',
      LIMIT_FIELD_COUNT: 'too many form fields',
    };
    const status = statusByCode[code] ?? 400;
    const message = errorByCode[code] ?? 'upload failed';
    return sendApiError(
      res,
      status,
      code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
      message,
      { details: { legacyCode: code } },
    );
  }

  if (err) {
    return sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
  }

  return sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
}

const mediaTasks = new Map();
const TASK_TTL_AFTER_DONE_MS = 10 * 60 * 1000;

function createMediaTask(taskId, projectId, info = {}) {
  const task = {
    id: taskId,
    projectId,
    status: 'queued',
    surface: info.surface,
    model: info.model,
    progress: [],
    file: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    waiters: new Set(),
  };
  mediaTasks.set(taskId, task);
  return task;
}

function appendTaskProgress(task, line) {
  task.progress.push(line);
  notifyTaskWaiters(task);
}

function notifyTaskWaiters(task) {
  const wakers = Array.from(task.waiters);
  for (const w of wakers) {
    try {
      w();
    } catch {
      // Never let one bad waiter block the rest.
    }
  }
  if (
    (task.status === 'done' || task.status === 'failed') &&
    !task._gcScheduled
  ) {
    task._gcScheduled = true;
    setTimeout(() => {
      if (task.waiters.size === 0) mediaTasks.delete(task.id);
    }, TASK_TTL_AFTER_DONE_MS).unref?.();
  }
}

export function createSseResponse(
  res,
  { keepAliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS } = {},
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const canWrite = () => !res.destroyed && !res.writableEnded;
  const writeKeepAlive = () => {
    if (canWrite()) {
      res.write(': keepalive\n\n');
      return true;
    }
    return false;
  };

  let heartbeat = null;
  if (keepAliveIntervalMs > 0) {
    heartbeat = setInterval(writeKeepAlive, keepAliveIntervalMs);
    heartbeat.unref?.();
  }

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);

  return {
    /** @param {ChatSseEvent['event'] | ProxySseEvent['event'] | string} event */
    send(event, data, id = null) {
      if (!canWrite()) return false;
      if (id !== null && id !== undefined) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    writeKeepAlive,
    cleanup,
    end() {
      cleanup();
      if (canWrite()) {
        res.end();
      }
    },
  };
}

export async function startServer({ port = 7456, host = process.env.OD_BIND_HOST || '127.0.0.1', returnServer = false } = {}) {
  let resolvedPort = port;
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  startOpenDesignRegistryWatcher();

  // Build the set of allowed browser origins for the current bind config.
  // Shared by the global origin middleware and isLocalSameOrigin() so
  // both use the same policy (loopback + explicit bind host, HTTP + HTTPS,
  // OD_WEB_PORT support).
  function buildAllowedOrigins() {
    const ports = [resolvedPort];
    const webPort = Number(process.env.OD_WEB_PORT);
    if (webPort && webPort !== resolvedPort) ports.push(webPort);
    const schemes = ['http', 'https'];
    const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
    return new Set(
      ports.flatMap((p) => [
        ...schemes.flatMap((s) => loopbackHosts.map((h) => `${s}://${h}:${p}`)),
        // When bound to a specific non-loopback address (e.g. Tailscale,
        // LAN IP, or 0.0.0.0), allow browser requests from that address
        // too so the documented --host escape hatch remains usable.
        ...schemes.map((s) => `${s}://${host}:${p}`),
      ]),
    );
  }

  // Routes that serve content to sandboxed iframes (Origin: null) for
  // read-only purposes.  All other /api routes reject Origin: null.
  const _NULL_ORIGIN_SAFE_GET_RE =
    /^\/projects\/[^/]+\/raw\//;

  // Reject cross-origin requests to API endpoints.
  // Health/version remain open for monitoring probes.
  // Non-browser clients (no Origin header) are always allowed.
  app.use('/api', (req, res, next) => {
    // Live artifact previews have stricter local-daemon validation and
    // loopback CORS handling on the route itself. Let that middleware produce
    // the structured error shape and preflight headers for preview embeds.
    if (/^\/live-artifacts\/[^/]+\/preview$/.test(req.path)) return next();

    const origin = req.headers.origin;
    // Non-browser client → allow.
    if (origin == null || origin === '') return next();

    // Origin: null (sandboxed iframes).  Only allowed for safe, read-only
    // routes that set their own CORS headers for canvas drawing.
    if (origin === 'null') {
      const isSafeReadOnly =
        req.method === 'GET' && _NULL_ORIGIN_SAFE_GET_RE.test(req.path);
      if (!isSafeReadOnly) {
        return res.status(403).json({ error: 'Origin: null not allowed for this route' });
      }
      return next();
    }

    // Fail-closed: block all browser origins until port is resolved.
    if (!resolvedPort) {
      return res.status(403).json({ error: 'Server initializing' });
    }

    if (!buildAllowedOrigins().has(String(origin))) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    }
    next();
  });
  const db = openDatabase(PROJECT_ROOT, { dataDir: RUNTIME_DATA_DIR });
  configureConnectorCredentialStore(new FileConnectorCredentialStore(RUNTIME_DATA_DIR));
  configureComposioConfigStore(RUNTIME_DATA_DIR);
  let daemonUrl = `http://127.0.0.1:${port}`;

  // Boot reconcile: any critique_runs row left in 'running' state by a prior
  // daemon crash gets flipped to 'interrupted' with rounds_json.recoveryReason
  // = 'daemon_restart' so the spec's daemon-restart-mid-run failure mode is
  // honored on every boot. staleAfterMs comes from CritiqueConfig, not a
  // hardcoded constant.
  const reconciledStaleRuns = reconcileStaleRuns(db, { staleAfterMs: critiqueCfg.totalTimeoutMs });
  if (reconciledStaleRuns > 0) {
    console.warn(`[critique] reconcileStaleRuns flipped ${reconciledStaleRuns} stale running row(s) to interrupted`);
  }

  if (process.env.OD_CODEX_DISABLE_PLUGINS === '1') {
    console.log('[od] Codex plugins disabled via OD_CODEX_DISABLE_PLUGINS=1');
  }

  // Warm agent-capability probes (e.g. whether the installed Claude Code
  // build advertises --include-partial-messages) so the first /api/chat
  // hits a populated cache even if /api/agents hasn't been called yet.
  void detectAgents().catch(() => {});

  await recoverStaleLiveArtifactRefreshes({ projectsRoot: PROJECTS_DIR }).catch((error) => {
    console.warn('[od] Failed to recover stale live artifact refreshes:', error);
  });

  if (fs.existsSync(STATIC_DIR)) {
    app.use(express.static(STATIC_DIR));
  }

  app.get('/api/health', async (_req, res) => {
    const versionInfo = await readCurrentAppVersionInfo();
    res.json({ ok: true, version: versionInfo.version });
  });

  app.get('/api/version', async (_req, res) => {
    const version = await readCurrentAppVersionInfo();
    res.json({ version });
  });

  app.get('/api/updates/check', async (_req, res) => {
    const current = await readCurrentAppVersionInfo();
    const update = await checkForAppUpdates(current);
    res.json(update);
  });

  app.get('/api/vault/designs', async (req, res) => {
    // When the external vault is reachable (env-configured or auto-discovered
    // via ~/.config/open-design/registry.json), treat it as the canonical
    // source of truth. The embedded snapshot at design-vault/data/designs is
    // only an offline fallback — otherwise stale snapshots would shadow
    // freshly-ingested templates living in the user's running vault.
    if (await ensureExternalVaultForRequest()) {
      try {
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        const result = await fetchVaultJson(`/api/designs${query}`);
        if (result.ok) {
          const raw = Array.isArray(result.json) ? result.json : result.json?.designs ?? [];
          const [designs, favoriteSlugs] = await Promise.all([
            Promise.all(raw.map((design) => enrichVaultDesignForClient(design))),
            readVaultFavoriteSlugsForClient(),
          ]);
          return res.json({ designs: filterVaultDesignsForQuery(markVaultDesignFavorites(designs, favoriteSlugs), req.query) });
        }
        // Non-2xx from external → fall through to embedded fallback below.
      } catch {
        // network error → fall through to embedded fallback below.
      }
    }
    const [localDesignsRaw, favoriteSlugs] = await Promise.all([
      listLocalVaultDesignsForClient(),
      readVaultFavoriteSlugsForClient(),
    ]);
    const localDesigns = filterVaultDesignsForQuery(markVaultDesignFavorites(localDesignsRaw, favoriteSlugs), req.query);
    if (localDesigns.length > 0 || !externalVaultEnabled()) return res.json({ designs: localDesigns });
    sendApiError(res, 502, 'INTERNAL_ERROR', 'Design Vault unavailable');
  });

  app.get('/api/vault/status', async (_req, res) => {
    const externalAvailable = await ensureExternalVaultForRequest();
    const designs = await listLocalVaultDesignsForClient();
    res.json({
      mode: externalAvailable ? 'external' : 'embedded',
      ingestionAvailable: externalAvailable,
      designsRoot: vaultDesignsRoot(),
      designCount: designs.length,
    });
  });

  app.get('/api/vault/discovery', async (_req, res) => {
    await refreshOpenDesignRegistryCache().catch(() => {});
    const explicit = externalVaultExplicitlyConfigured();
    const registry = openDesignRegistryCache;
    const candidateOrigin = vaultOrigin();
    const probe = await probeVaultHealth(candidateOrigin);

    let state;
    if (probe.ok) state = 'running';
    else if (explicit) state = 'configured-not-reachable';
    else if (registry.baseUrl && !registry.fresh) state = 'installed-not-running';
    else if (registry.baseUrl && registry.fresh && !probe.ok) state = 'installed-not-running';
    else state = 'not-installed';

    res.json({
      spec: 'open-design/discovery@v1',
      state,
      baseUrl: probe.ok ? candidateOrigin : registry.baseUrl || null,
      version: probe.ok ? probe.data?.version ?? null : registry.version,
      vaultSpec: probe.ok ? probe.data?.spec ?? null : registry.spec,
      capabilities: probe.ok ? probe.data?.capabilities ?? [] : registry.capabilities,
      designCount: probe.ok ? probe.data?.designCount ?? null : null,
      lastSeen: registry.lastSeen,
      explicit,
      registryPath: openDesignRegistryPath(),
      install: {
        // Placeholder — replace with the published git URL once the design-vault
        // repo has a public home.
        cloneCmd: 'git clone <git-clone-url> ~/project/design-vault && cd ~/project/design-vault && pnpm install && pnpm dev',
        runCmd: 'cd ~/project/design-vault && pnpm dev',
        defaultBaseUrl: 'http://127.0.0.1:3217',
      },
    });
  });

  app.post('/api/vault/sync', async (_req, res) => {
    try {
      res.json(await syncLocalVaultAgentContexts());
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', `Design Vault sync failed: ${String(err?.message || err)}`);
    }
  });

  app.delete('/api/vault/designs/:slug', async (req, res) => {
    try {
      const slug = cleanString(req.params.slug);
      if (!isVaultDesignSlugSegment(slug)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid Design Vault template slug');
      }
      const deleted = await deleteLocalVaultDesignForClient(slug);
      if (deleted) {
        return res.json({
          ok: true,
          slug: deleted.slug,
          deleted: true,
          removedPaths: deleted.removedPaths,
        });
      }
      if (!externalVaultEnabled()) {
        return sendApiError(res, 404, 'NOT_FOUND', 'Design Vault template not found');
      }
      const target = new URL(`/api/designs/${encodeURIComponent(slug)}`, vaultOrigin());
      const upstream = await fetch(target, { method: 'DELETE' });
      const json = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        return res.status(upstream.status).json(json ?? { error: 'vault request failed' });
      }
      return res.json({
        ...(json && typeof json === 'object' ? json : {}),
        ok: true,
        slug,
        deleted: true,
      });
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', `Design Vault delete failed: ${String(err?.message || err)}`);
    }
  });

  app.get('/api/vault/designs/:slug', async (req, res) => {
    try {
      const slug = cleanString(req.params.slug);
      const localDesign = await loadLocalVaultDesignForClient(slug);
      const favoriteSlugs = await readVaultFavoriteSlugsForClient();
      if (localDesign || !externalVaultEnabled()) {
        if (localDesign) return res.json({ design: markVaultDesignFavorites([localDesign], favoriteSlugs)[0] });
        return sendApiError(res, 404, 'NOT_FOUND', 'Design Vault template not found');
      }
      const result = await fetchVaultJson(`/api/designs/${encodeURIComponent(slug)}`);
      if (!result.ok) {
        return res.status(result.status).json(result.json ?? { error: 'vault request failed' });
      }
      const design = await enrichVaultDesignForClient(result.json?.design ?? result.json);
      res.json({ design: markVaultDesignFavorites([design], favoriteSlugs)[0] });
    } catch (err) {
      const context = await loadVaultAgentContextFromLocalSlug(cleanString(req.params.slug));
      if (context) return res.json({ design: context });
      sendApiError(res, 502, 'INTERNAL_ERROR', `Design Vault unavailable: ${String(err?.message || err)}`);
    }
  });

  app.get('/api/vault/designs/:slug/asset', async (req, res) => {
    try {
      const slug = cleanString(req.params.slug);
      const assetPath = cleanString(req.query?.path);
      if (!slug || !assetPath) return sendApiError(res, 400, 'BAD_REQUEST', 'asset path required');
      const context = await loadVaultAgentContextFromLocalSlug(slug);
      let root = context?.designPath
        ? path.dirname(context.designPath)
        : path.join(vaultDesignsRoot(), slug);
      if (!fs.existsSync(root) && externalVaultEnabled()) {
        const result = await fetchVaultJson(`/api/designs/${encodeURIComponent(slug)}`);
        const design = result.ok ? result.json?.design ?? result.json : null;
        const enriched = await normalizeVaultAgentContext(design);
        root = enriched?.designPath ? path.dirname(enriched.designPath) : root;
      }
      const target = path.resolve(root, assetPath);
      if (!isPathWithin(root, target)) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid asset path');
      if (!fs.existsSync(target)) return sendApiError(res, 404, 'NOT_FOUND', 'asset not found');
      res
        .set('cache-control', 'no-store')
        .sendFile(target);
    } catch (err) {
      sendApiError(res, 502, 'INTERNAL_ERROR', `Design Vault asset unavailable: ${String(err?.message || err)}`);
    }
  });

  app.get('/api/vault/designs/:slug/preview', async (req, res) => {
    try {
      const slug = cleanString(req.params.slug);
      const kind = req.query?.kind === 'card' ? 'card' : req.query?.kind === 'ppt' ? 'ppt' : 'web';
      if (await sendLocalVaultPreview(slug, kind, res)) return;
      if (!externalVaultEnabled()) return sendFallbackVaultPreview(slug, kind, res);
      const target = new URL(`/api/designs/${encodeURIComponent(slug)}/preview`, vaultOrigin());
      target.searchParams.set('kind', kind);
      const surface = cleanString(req.query?.surface);
      if (surface) target.searchParams.set('surface', surface);
      const upstream = await fetch(target);
      const body = await upstream.text();
      if (!upstream.ok) {
        if (await sendLocalVaultPreview(slug, kind, res)) return;
        return sendFallbackVaultPreview(slug, kind, res);
      }
      res
        .status(upstream.status)
        .set('content-type', upstream.headers.get('content-type') ?? 'text/html; charset=utf-8')
        .set('cache-control', 'no-store')
        .send(rewriteVaultPreviewHtml(body, slug));
    } catch (err) {
      const slug = cleanString(req.params.slug);
      const kind = req.query?.kind === 'card' ? 'card' : req.query?.kind === 'ppt' ? 'ppt' : 'web';
      if (await sendLocalVaultPreview(slug, kind, res)) return;
      sendFallbackVaultPreview(slug, kind, res);
    }
  });

  app.post('/api/vault/ingestions', async (req, res) => {
    try {
      const body = req.body || {};
      if (!(await ensureExternalVaultForRequest())) {
        return res.status(202).json({
          job: {
            id: `embedded-${Date.now().toString(36)}`,
            status: 'failed',
            url: typeof body.url === 'string' ? body.url : '',
            mode: body.mode === 'clone-website' ? 'clone-website' : 'url',
            error: 'Live Design Vault is not reachable. Start Design Vault or configure OPENPPT_VAULT_ORIGIN.',
          },
        });
      }
      const result = await fetchVaultJson('/api/ingestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: typeof body.url === 'string' ? body.url : '',
          mode: body.mode === 'clone-website' ? 'clone-website' : 'url',
        }),
      });
      if (!result.ok) {
        return res.status(result.status).json(result.json ?? { error: 'vault request failed' });
      }
      res.json({ job: result.json });
    } catch (err) {
      sendApiError(res, 502, 'INTERNAL_ERROR', `Design Vault unavailable: ${String(err?.message || err)}`);
    }
  });

  app.get('/api/vault/jobs/:jobId', async (req, res) => {
    try {
      if (!(await ensureExternalVaultForRequest())) {
        return res.status(404).json({
          job: {
            id: cleanString(req.params.jobId),
            status: 'failed',
            error: 'Live Design Vault is not reachable. Start Design Vault or configure OPENPPT_VAULT_ORIGIN.',
          },
        });
      }
      const result = await fetchVaultJson(`/api/jobs/${encodeURIComponent(cleanString(req.params.jobId))}`);
      if (!result.ok) {
        return res.status(result.status).json(result.json ?? { error: 'vault request failed' });
      }
      res.json({ job: result.json });
    } catch (err) {
      sendApiError(res, 502, 'INTERNAL_ERROR', `Design Vault unavailable: ${String(err?.message || err)}`);
    }
  });

  registerConnectorRoutes(app, { sendApiError, authorizeToolRequest, projectsRoot: PROJECTS_DIR, requireLocalDaemonRequest });

  app.get('/api/connectors/composio/config', (_req, res) => {
    try {
      res.json(readPublicComposioConfig());
    } catch (err) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/connectors/composio/config', requireLocalDaemonRequest, (req, res) => {
    try {
      const before = readComposioConfig();
      const cfg = writeComposioConfig(req.body);
      const after = readComposioConfig();
      composioConnectorProvider.clearDiscoveryCache();
      if (!cfg.configured || (before.apiKey && before.apiKey !== after.apiKey)) {
        deleteConnectorCredentialsByProvider('composio');
      }
      res.json(cfg);
    } catch (err) {
      res.status(400).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  // ---- Projects (DB-backed) -------------------------------------------------

  // Soft "what is the user looking at right now in Open Design?" channel. The
  // web UI POSTs the current project + file on every route change;
  // the MCP surface reads it so a coding agent in another repo can
  // resolve "the design I have open" without the user typing the
  // project id. In-memory only - daemon restart clears it.
  /** @type {{ projectId: string; fileName: string | null; ts: number } | null} */
  let activeContext = null;
  const ACTIVE_CONTEXT_TTL_MS = 5 * 60 * 1000;

  // Active context is private to the local machine. The daemon binds
  // 0.0.0.0 by default, so without an origin check a peer on the LAN
  // could read what the user is currently looking at (GET) or spoof
  // it to redirect MCP fallbacks (POST). The web proxies same-origin
  // and the MCP runs in-process via 127.0.0.1, so both legitimate
  // callers pass the check.
  app.post('/api/active', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const body = req.body || {};
      if (body.active === false) {
        activeContext = null;
        res.json({ active: false });
        return;
      }
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      if (!projectId) {
        sendApiError(res, 400, 'BAD_REQUEST', 'projectId is required');
        return;
      }
      const fileName =
        typeof body.fileName === 'string' && body.fileName.length > 0
          ? body.fileName
          : null;
      activeContext = { projectId, fileName, ts: Date.now() };
      res.json({ active: true, ...activeContext });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.get('/api/active', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    if (!activeContext || Date.now() - activeContext.ts > ACTIVE_CONTEXT_TTL_MS) {
      activeContext = null;
      res.json({ active: false });
      return;
    }
    const project = getProject(db, activeContext.projectId);
    res.json({
      active: true,
      projectId: activeContext.projectId,
      projectName: project?.name ?? null,
      fileName: activeContext.fileName,
      ts: activeContext.ts,
      ageMs: Date.now() - activeContext.ts,
    });
  });

  // Surfaces the absolute paths to `node` + `apps/daemon/dist/cli.js`
  // so the Settings → MCP server panel can render snippets that work
  // even when `od` isn't on the user's PATH (the common case for
  // source clones - and macOS/Linux ship a /usr/bin/od octal-dump
  // tool that shadows ours anyway). Computed from import.meta.url so
  // both src/ (tsx dev) and dist/ (built) launches resolve to the
  // same dist/cli.js path. Cached for 5s because the panel pings on
  // every open and the path lookup + two existsSync calls are cheap
  // but not free, and these paths cannot change without a daemon
  // restart anyway.
  const INSTALL_INFO_TTL_MS = 5000;
  let installInfoCache: { t: number; payload: object } | null = null;

  app.get('/api/mcp/install-info', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const now = Date.now();
    if (installInfoCache && now - installInfoCache.t < INSTALL_INFO_TTL_MS) {
      return res.json(installInfoCache.payload);
    }
    let cliPath;
    try {
      cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    } catch (err) {
      return sendApiError(res, 500, 'CLI_RESOLVE_FAILED', String(err));
    }
    const cliExists = fs.existsSync(cliPath);
    // process.execPath is the absolute path to the node binary that
    // is running the daemon RIGHT NOW. We prefer it over bare `node`
    // because IDE-spawned MCP clients inherit a minimal PATH from the
    // OS launcher (Spotlight, Dock, etc.) that often does not see
    // user-level node installs (nvm, fnm, asdf). On rare occasions
    // (uninstall mid-session, exotic embeds) the path may not exist
    // by the time the user copies the snippet; catch that and warn.
    const nodeExists = fs.existsSync(process.execPath);
    const hints: string[] = [];
    if (!cliExists) {
      hints.push(
        'apps/daemon/dist/cli.js is missing. Run `pnpm --filter @open-design/daemon build` and refresh.',
      );
    }
    if (!nodeExists) {
      hints.push(
        `Node binary at ${process.execPath} no longer exists. Reinstall Node and restart the daemon.`,
      );
    }
    const payload = {
      command: process.execPath,
      args: [cliPath, 'mcp', '--daemon-url', `http://127.0.0.1:${resolvedPort}`],
      daemonUrl: `http://127.0.0.1:${resolvedPort}`,
      // Surface platform so the install panel can localize path hints
      // (~/.cursor vs %USERPROFILE%\.cursor) and keyboard shortcuts
      // (Cmd vs Ctrl). One of 'darwin' | 'linux' | 'win32' in
      // practice; the panel falls back to POSIX wording for anything
      // else.
      platform: process.platform,
      cliExists,
      nodeExists,
      buildHint: hints.length ? hints.join(' ') : null,
    };
    installInfoCache = { t: now, payload };
    res.json(payload);
  });

  app.get('/api/projects', (_req, res) => {
    try {
      const latestRunStatuses = listLatestProjectRunStatuses(db);
      const awaitingInputProjects = listProjectsAwaitingInput(db);
      const activeRunStatuses = new Map();
      for (const run of design.runs.list()) {
        if (!run.projectId) continue;
        const runStatus = projectStatusFromRun(run);
        if (design.runs.isTerminal(run.status)) {
          const existing = latestRunStatuses.get(run.projectId);
          if (!existing || run.updatedAt > (existing.updatedAt ?? 0)) {
            latestRunStatuses.set(run.projectId, runStatus);
          }
        } else {
          const existing = activeRunStatuses.get(run.projectId);
          if (!existing || run.updatedAt > (existing.updatedAt ?? 0)) {
            activeRunStatuses.set(run.projectId, runStatus);
          }
        }
      }
      /** @type {import('@open-design/contracts').ProjectsResponse} */
      const body = {
        projects: listProjects(db).map((project) => ({
          ...project,
          status: composeProjectDisplayStatus(
            activeRunStatuses.get(project.id) ??
              latestRunStatuses.get(project.id) ?? { value: 'not_started' },
            awaitingInputProjects,
            project.id,
          ),
        })),
      };
      res.json(body);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err));
    }
  });

  function projectStatusFromRun(run) {
    return {
      value: normalizeProjectDisplayStatus(run.status),
      updatedAt: run.updatedAt,
      runId: run.id,
    };
  }

  app.post('/api/projects', async (req, res) => {
    try {
      const { id, name, skillId, designSystemId, pendingPrompt, metadata } =
        req.body || {};
      if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid project id');
      }
      if (typeof name !== 'string' || !name.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'name required');
      }
      const now = Date.now();
      let project = insertProject(db, {
        id,
        name: name.trim(),
        skillId: skillId ?? null,
        designSystemId: designSystemId ?? null,
        pendingPrompt: pendingPrompt || null,
        metadata:
          metadata && typeof metadata === 'object'
            ? {
                ...metadata,
                ...(metadata.kind === 'deck'
                  ? {
                      kind: 'deck',
                      slideId: isSafeSlideId(metadata.slideId)
                        ? metadata.slideId
                        : slugifySlideId(name),
                      slideWorkspace: 'slides',
                      deliveryOptions: {
                        html: true,
                        pdf: true,
                        pptx: true,
                        ...(metadata.deliveryOptions ?? {}),
                      },
                    }
                  : {}),
                ...(Array.isArray(metadata.linkedDirs)
                  ? (() => {
                      const v = validateLinkedDirs(metadata.linkedDirs);
                      return v.error ? {} : { linkedDirs: v.dirs };
                    })()
                  : {}),
              }
            : null,
        createdAt: now,
        updatedAt: now,
      });
      if (project.metadata?.kind === 'deck') {
        const seeded = await ensureOpenPptSlideProject(PROJECTS_DIR, id, project);
        if (seeded?.metadata && seeded?.entryFile) {
          project =
            updateProject(db, id, {
              metadata: {
                ...seeded.metadata,
                entryFile: seeded.entryFile,
              },
            }) ?? project;
          // Keep the starter TSX as hidden working state. The workspace should
          // open the deck source only after an agent actually writes/builds it,
          // which is handled by the web auto-open-on-Write/Edit flow.
        }
      }
      // Seed a default conversation so the UI always has somewhere to write.
      const cid = randomId();
      insertConversation(db, {
        id: cid,
        projectId: id,
        title: null,
        createdAt: now,
        updatedAt: now,
      });
      // For "from template" projects, seed the chosen template's snapshot
      // HTML into the new project folder so the agent can Read/edit files
      // on disk (the system prompt also embeds them, but a real on-disk
      // copy lets the agent treat them as the project's working state).
      if (
        metadata &&
        typeof metadata === 'object' &&
        metadata.kind === 'template' &&
        typeof metadata.templateId === 'string'
      ) {
        const tpl = getTemplate(db, metadata.templateId);
        if (tpl && Array.isArray(tpl.files) && tpl.files.length > 0) {
          await ensureProject(PROJECTS_DIR, id);
          for (const f of tpl.files) {
            if (
              !f ||
              typeof f.name !== 'string' ||
              typeof f.content !== 'string'
            ) {
              continue;
            }
            try {
              await writeProjectFile(
                PROJECTS_DIR,
                id,
                f.name,
                Buffer.from(f.content, 'utf8'),
              );
            } catch {
              // Skip individual file failures — the template snapshot is
              // best-effort; the agent still has the embedded copy.
            }
          }
        }
      }
      /** @type {import('@open-design/contracts').CreateProjectResponse} */
      const body = { project, conversationId: cid };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.post(
    '/api/import/claude-design',
    importUpload.single('file'),
    async (req, res) => {
      try {
        if (!req.file)
          return res.status(400).json({ error: 'zip file required' });
        const originalName =
          req.file.originalname || 'Claude Design export.zip';
        if (!/\.zip$/i.test(originalName)) {
          fs.promises.unlink(req.file.path).catch(() => {});
          return res.status(400).json({ error: 'expected a .zip file' });
        }
        const id = randomId();
        const now = Date.now();
        const baseName =
          originalName.replace(/\.zip$/i, '').trim() || 'Claude Design import';
        const imported = await importClaudeDesignZip(
          req.file.path,
          projectDir(PROJECTS_DIR, id),
        );
        fs.promises.unlink(req.file.path).catch(() => {});

        const project = insertProject(db, {
          id,
          name: baseName,
          skillId: null,
          designSystemId: null,
          pendingPrompt: `Imported from Claude Design ZIP: ${originalName}. Continue editing ${imported.entryFile}.`,
          metadata: {
            kind: 'prototype',
            importedFrom: 'claude-design',
            entryFile: imported.entryFile,
            sourceFileName: originalName,
          },
          createdAt: now,
          updatedAt: now,
        });
        const cid = randomId();
        insertConversation(db, {
          id: cid,
          projectId: id,
          title: 'Imported Claude Design project',
          createdAt: now,
          updatedAt: now,
        });
        setTabs(db, id, [imported.entryFile], imported.entryFile);
        res.json({
          project,
          conversationId: cid,
          entryFile: imported.entryFile,
          files: imported.files,
        });
      } catch (err) {
        if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
        res.status(400).json({ error: String(err) });
      }
    },
  );

  app.get('/api/projects/:id', (req, res) => {
    const project = getProject(db, req.params.id);
    if (!project)
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    /** @type {import('@open-design/contracts').ProjectResponse} */
    const body = { project };
    res.json(body);
  });

  app.patch('/api/projects/:id', (req, res) => {
    try {
      const patch = req.body || {};
      if (patch.metadata?.linkedDirs) {
        const validated = validateLinkedDirs(patch.metadata.linkedDirs);
        if (validated.error) {
          return sendApiError(res, 400, 'INVALID_LINKED_DIR', validated.error);
        }
        patch.metadata.linkedDirs = validated.dirs;
      }
      const project = updateProject(db, req.params.id, patch);
      if (!project)
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
      /** @type {import('@open-design/contracts').ProjectResponse} */
      const body = { project };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.delete('/api/projects/:id', async (req, res) => {
    try {
      dbDeleteProject(db, req.params.id);
      await removeProjectDir(PROJECTS_DIR, req.params.id).catch(() => {});
      /** @type {import('@open-design/contracts').OkResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  // SSE stream of file-changed events for a project. Drives preview live-reload.
  // Receipt of a `file-changed` event triggers a file-list refresh, which
  // propagates new mtimes through to FileViewer iframes (the URL-load
  // `?v=${mtime}` cache-bust from PR #384 then reloads the iframe automatically).
  // Subscribers come and go as users open/close project tabs; the underlying
  // chokidar watcher is refcounted in project-watchers.ts so we never hold
  // descriptors for projects no UI is looking at.
  app.get('/api/projects/:id/events', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    }
    let sub;
    try {
      const sse = createSseResponse(res);
      const projectEventSink = (payload) => {
        sse.send(payload.type, payload);
      };
      let sinks = activeProjectEventSinks.get(req.params.id);
      if (!sinks) {
        sinks = new Set();
        activeProjectEventSinks.set(req.params.id, sinks);
      }
      sinks.add(projectEventSink);
      sub = subscribeFileEvents(PROJECTS_DIR, req.params.id, (evt) => {
        sse.send('file-changed', evt);
      });
      sub.ready.then(() => sse.send('ready', { projectId: req.params.id })).catch(() => {});
      const cleanup = () => {
        if (sub) {
          const { unsubscribe } = sub;
          sub = null;
          Promise.resolve(unsubscribe()).catch(() => {});
        }
        const currentSinks = activeProjectEventSinks.get(req.params.id);
        currentSinks?.delete(projectEventSink);
        if (currentSinks?.size === 0) activeProjectEventSinks.delete(req.params.id);
      };
      res.on('close', cleanup);
      res.on('finish', cleanup);
    } catch (err) {
      if (sub) Promise.resolve(sub.unsubscribe()).catch(() => {});
      if (!res.headersSent) sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  async function resolveOpenPptSlideRequest(req, res, inputSlideId = null) {
    const project = getProject(db, req.params.id);
    if (!project) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
      return null;
    }
    const metadata = project.metadata ?? {};
    if (metadata.kind !== 'deck') {
      sendApiError(res, 400, 'BAD_REQUEST', 'project is not an SFA deck');
      return null;
    }
    const seeded = await ensureOpenPptSlideProject(PROJECTS_DIR, req.params.id, project);
    if (seeded?.metadata && seeded?.entryFile) {
      updateProject(db, req.params.id, {
        metadata: {
          ...seeded.metadata,
          entryFile: seeded.entryFile,
        },
      });
    }
    const cwd = await ensureProject(PROJECTS_DIR, req.params.id);
    const slideId =
      cleanString(inputSlideId) ||
      cleanString(req.query?.slideId) ||
      seeded?.metadata?.slideId ||
      metadata.slideId ||
      slugifySlideId(project.name);
    if (!isSafeSlideId(slideId)) {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid slide id');
      return null;
    }
    const file = openPptSlidePath(cwd, slideId);
    if (!file) {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid slide path');
      return null;
    }
    return {
      project,
      cwd,
      slideId,
      file,
      relativePath: openPptSlideRelativePath(slideId),
    };
  }

  // ---- Conversations --------------------------------------------------------

  app.get('/api/projects/:id/conversations', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json({ conversations: listConversations(db, req.params.id) });
  });

  app.post('/api/projects/:id/conversations', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const { title } = req.body || {};
    const now = Date.now();
    const conv = insertConversation(db, {
      id: randomId(),
      projectId: req.params.id,
      title: typeof title === 'string' ? title.trim() || null : null,
      createdAt: now,
      updatedAt: now,
    });
    res.json({ conversation: conv });
  });

  app.patch('/api/projects/:id/conversations/:cid', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'not found' });
    }
    const updated = updateConversation(db, req.params.cid, req.body || {});
    res.json({ conversation: updated });
  });

  app.delete('/api/projects/:id/conversations/:cid', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'not found' });
    }
    deleteConversation(db, req.params.cid);
    res.json({ ok: true });
  });

  // ---- Messages -------------------------------------------------------------

  app.get('/api/projects/:id/conversations/:cid/messages', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({ messages: listMessages(db, req.params.cid) });
  });

  app.put('/api/projects/:id/conversations/:cid/messages/:mid', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    const m = req.body || {};
    if (m.id && m.id !== req.params.mid) {
      return res.status(400).json({ error: 'id mismatch' });
    }
    const saved = upsertMessage(db, req.params.cid, {
      ...m,
      id: req.params.mid,
    });
    // Bump the parent project's updatedAt so the project list re-orders.
    updateProject(db, req.params.id, {});
    res.json({ message: saved });
  });

  // ---- Preview comments ----------------------------------------------------

  app.get('/api/projects/:id/conversations/:cid/comments', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({
      comments: listPreviewComments(db, req.params.id, req.params.cid),
    });
  });

  app.post('/api/projects/:id/conversations/:cid/comments', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    try {
      const comment = upsertPreviewComment(
        db,
        req.params.id,
        req.params.cid,
        req.body || {},
      );
      updateProject(db, req.params.id, {});
      res.json({ comment });
    } catch (err) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      try {
        const comment = updatePreviewCommentStatus(
          db,
          req.params.id,
          req.params.cid,
          req.params.commentId,
          req.body?.status,
        );
        if (!comment)
          return res.status(404).json({ error: 'comment not found' });
        updateProject(db, req.params.id, {});
        res.json({ comment });
      } catch (err) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.delete(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const ok = deletePreviewComment(
        db,
        req.params.id,
        req.params.cid,
        req.params.commentId,
      );
      if (!ok) return res.status(404).json({ error: 'comment not found' });
      updateProject(db, req.params.id, {});
      res.json({ ok: true });
    },
  );

  // ---- OpenPPT slide feedback ----------------------------------------------

  app.get('/api/projects/:id/slide-feedback', (req, res) => {
    const project = getProject(db, req.params.id);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    }
    const conversationId =
      typeof req.query?.conversationId === 'string'
        ? req.query.conversationId
        : null;
    res.json({
      feedback: listSlideFeedback(db, req.params.id, conversationId),
    });
  });

  app.post('/api/projects/:id/slide-feedback', (req, res) => {
    const project = getProject(db, req.params.id);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    }
    try {
      const body = req.body || {};
      const conversationId =
        typeof body.conversationId === 'string' && body.conversationId
          ? body.conversationId
          : null;
      if (conversationId) {
        const conv = getConversation(db, conversationId);
        if (!conv || conv.projectId !== req.params.id) {
          return sendApiError(res, 404, 'BAD_REQUEST', 'conversation not found');
        }
      }
      const feedback = insertSlideFeedback(db, req.params.id, conversationId, body);
      updateProject(db, req.params.id, {});
      res.json({ feedback });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.patch('/api/projects/:id/slide-feedback/:feedbackId', (req, res) => {
    const project = getProject(db, req.params.id);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    }
    try {
      const feedback = updateSlideFeedbackStatus(
        db,
        req.params.id,
        req.params.feedbackId,
        req.body?.status,
      );
      if (!feedback) {
        return sendApiError(res, 404, 'BAD_REQUEST', 'feedback not found');
      }
      updateProject(db, req.params.id, {});
      res.json({ feedback });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.delete('/api/projects/:id/slide-feedback/:feedbackId', (req, res) => {
    const project = getProject(db, req.params.id);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    }
    const ok = deleteSlideFeedback(db, req.params.id, req.params.feedbackId);
    if (!ok) {
      return sendApiError(res, 404, 'BAD_REQUEST', 'feedback not found');
    }
    updateProject(db, req.params.id, {});
    res.json({ ok: true });
  });

  // ---- OpenPPT slide adapter ------------------------------------------------

  app.get('/api/projects/:id/open-slide/source', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res);
      if (!slide) return;
      const source = await fs.promises.readFile(slide.file, 'utf8');
      res.json({
        slideId: slide.slideId,
        path: slide.relativePath,
        source,
        comments: parseSlideComments(source),
      });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/open-slide/module', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res);
      if (!slide) return;
      const source = await fs.promises.readFile(slide.file, 'utf8');
      const compiled = await compileOpenPptSlideModule(source);
      res.json({
        slideId: slide.slideId,
        path: slide.relativePath,
        code: compiled.code,
        diagnostics: compiled.diagnostics,
        comments: parseSlideComments(source),
      });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/open-slide/export/assets', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res);
      if (!slide) return;
      const source = await fs.promises.readFile(slide.file, 'utf8');
      const gate = openPptVaultTemplateGate(slide.project?.metadata, source);
      if (gate) return sendApiError(res, 409, 'BAD_REQUEST', gate);
      const mediaGate = openPptDeckMediaGate(slide.project?.metadata, source);
      if (mediaGate) return sendApiError(res, 409, 'BAD_REQUEST', mediaGate);
      const tokenStylesheet = await readVaultTokenStylesheet(
        slide.project?.metadata,
        slide.project?.designSystemId,
      );
      const artifacts = await buildOpenPptExportArtifacts({
        source,
        slideDir: path.dirname(slide.file),
        title: slide.project?.name,
        target: 'assets',
        tokenStylesheet,
      });
      const filename = `${sanitizeArchiveFilename(artifacts.slug || slide.project?.name || slide.slideId) || 'sfa-deck'}-html-pdf-assets.zip`;
      const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'sfa-deck.zip';
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(artifacts.zip);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/open-slide/export/pptx', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res);
      if (!slide) return;
      const source = await fs.promises.readFile(slide.file, 'utf8');
      const gate = openPptVaultTemplateGate(slide.project?.metadata, source);
      if (gate) return sendApiError(res, 409, 'BAD_REQUEST', gate);
      const mediaGate = openPptDeckMediaGate(slide.project?.metadata, source);
      if (mediaGate) return sendApiError(res, 409, 'BAD_REQUEST', mediaGate);
      const requestedStrategy = req.query?.strategy === 'raster' ? 'raster' : 'editable';
      const tokenStylesheet = await readVaultTokenStylesheet(
        slide.project?.metadata,
        slide.project?.designSystemId,
      );
      const artifacts = await buildOpenPptExportArtifacts({
        source,
        slideDir: path.dirname(slide.file),
        title: slide.project?.name,
        target: 'pptx',
        pptxStrategy: requestedStrategy,
        tokenStylesheet,
      });
      const strategySuffix = artifacts.pptxStrategy === 'raster' ? '-raster' : '';
      const filename = `${sanitizeArchiveFilename(artifacts.slug || slide.project?.name || slide.slideId) || 'sfa-deck'}${strategySuffix}.pptx`;
      const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'sfa-deck.pptx';
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      res.setHeader('X-OpenPPT-PPTX-Strategy', artifacts.pptxStrategy || requestedStrategy);
      if (artifacts.pptxStats) {
        res.setHeader('X-OpenPPT-PPTX-Layers', JSON.stringify(artifacts.pptxStats));
      }
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(artifacts.pptx);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.patch('/api/projects/:id/open-slide/source', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res, req.body?.slideId);
      if (!slide) return;
      const body = req.body || {};
      const current = await fs.promises.readFile(slide.file, 'utf8');
      const source =
        typeof body.content === 'string'
          ? body.content
          : applyLineEdits(current, body.edits);
      await fs.promises.writeFile(slide.file, source, 'utf8');
      updateProject(db, req.params.id, {});
      res.json({
        ok: true,
        slideId: slide.slideId,
        path: slide.relativePath,
        comments: parseSlideComments(source),
      });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/open-slide/edit-batch', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res, req.body?.slideId);
      if (!slide) return;
      const body = req.body || {};
      const source = await fs.promises.readFile(slide.file, 'utf8');
      const applied = await applyOpenPptEditBatch(source, body.edits);
      if (applied.changed) {
        await fs.promises.writeFile(slide.file, applied.source, 'utf8');
        updateProject(db, req.params.id, {});
      }
      res.json({
        ok: true,
        changed: applied.changed,
        slideId: slide.slideId,
        path: slide.relativePath,
        results: applied.results,
        comments: parseSlideComments(applied.source),
      });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/open-slide/design', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res);
      if (!slide) return;
      const source = await fs.promises.readFile(slide.file, 'utf8');
      const parsed = parseOpenPptDesign(source);
      res.json({
        slideId: slide.slideId,
        path: slide.relativePath,
        design: parsed.design,
        warning: parsed.warning,
      });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.put('/api/projects/:id/open-slide/design', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res, req.body?.slideId);
      if (!slide) return;
      const body = req.body || {};
      const patch = body.patch ?? body.design;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'design patch required');
      }
      const source = await fs.promises.readFile(slide.file, 'utf8');
      const parsed = parseOpenPptDesign(source);
      const design = mergeOpenPptDesign(parsed.design, patch);
      await fs.promises.writeFile(slide.file, writeOpenPptDesign(source, design), 'utf8');
      updateProject(db, req.params.id, {});
      res.json({
        ok: true,
        slideId: slide.slideId,
        path: slide.relativePath,
        design,
        warning: parsed.warning,
      });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/open-slide/vault-template', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      if (!project) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
      const metadata = project.metadata ?? {};
      if (metadata.kind !== 'deck') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'project is not an SFA deck');
      }
      const requestedSlug = cleanString(req.body?.slug) || cleanString(metadata.vaultTemplate?.slug);
      if (!requestedSlug) return sendApiError(res, 400, 'BAD_REQUEST', 'vault template slug required');
      const vaultTemplate = await fetchVaultTemplateMetadata(requestedSlug);
      const materialized = await materializeVaultAgentContext(vaultTemplate, {
        skillsDir: SKILLS_DIR,
        designSystemsDir: DESIGN_SYSTEMS_DIR,
      }).catch((err) => ({
        warnings: [`failed to materialize Design Vault context: ${String(err?.message || err)}`],
      }));
      let nextProject = updateProject(db, req.params.id, {
        ...(materialized.skillId ? { skillId: materialized.skillId } : {}),
        ...(materialized.designSystemId ? { designSystemId: materialized.designSystemId } : {}),
        metadata: {
          ...metadata,
          vaultTemplate,
        },
      });
      const warnings = Array.isArray(materialized.warnings) ? [...materialized.warnings] : [];
      let applied = false;
      if (req.body?.applyToCurrentDeck !== false) {
        const cwd = await ensureProject(PROJECTS_DIR, req.params.id);
        const slideId =
          cleanString(req.body?.slideId) ||
          cleanString(metadata.slideId) ||
          cleanString(nextProject?.metadata?.slideId) ||
          slugifySlideId(project.name);
        const file = openPptSlidePath(cwd, slideId);
        if (!file) {
          warnings.push('invalid slide id; template metadata was locked but the current deck was not re-themed');
        } else if (fs.existsSync(file)) {
          const source = await fs.promises.readFile(file, 'utf8');
          const parsed = parseOpenPptDesign(source);
          const nextDesign = openPptDesignFromVaultTemplate(vaultTemplate, parsed.design);
          await fs.promises.writeFile(file, writeOpenPptDesign(source, nextDesign), 'utf8');
          updateProject(db, req.params.id, {});
          applied = true;
        } else {
          const seeded = await ensureOpenPptSlideProject(PROJECTS_DIR, req.params.id, nextProject);
          if (seeded?.metadata && seeded?.entryFile) {
            nextProject = updateProject(db, req.params.id, {
              metadata: {
                ...seeded.metadata,
                vaultTemplate,
                entryFile: seeded.entryFile,
              },
            });
            applied = true;
          } else {
            warnings.push('deck source file does not exist yet; template will apply to the next generation prompt');
          }
        }
      }
      res.json({
        ok: true,
        project: getProject(db, req.params.id),
        vaultTemplate,
        applied,
        warnings,
      });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/open-slide/comments', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res);
      if (!slide) return;
      const source = await fs.promises.readFile(slide.file, 'utf8');
      res.json({
        slideId: slide.slideId,
        path: slide.relativePath,
        comments: parseSlideComments(source),
      });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/open-slide/comments', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res, req.body?.slideId);
      if (!slide) return;
      const body = req.body || {};
      const note = cleanString(body.text) || cleanString(body.note);
      if (!note) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'comment text required');
      }
      const line = Number.isInteger(body.line) ? body.line : 1;
      let commentId = `c-${randomId().replace(/[^a-f0-9]/gi, '').slice(0, 8).padEnd(8, '0')}`;
      const persistSourceMarker = body.persistSourceMarker === true;
      if (persistSourceMarker) {
        const source = await fs.promises.readFile(slide.file, 'utf8');
        const inserted = insertSlideComment(source, {
          line,
          text: note,
          hint: cleanString(body.hint),
        });
        commentId = inserted.id;
        await fs.promises.writeFile(slide.file, inserted.source, 'utf8');
      }
      const conversationId =
        typeof body.conversationId === 'string' && body.conversationId
          ? body.conversationId
          : null;
      const feedback = insertSlideFeedback(db, req.params.id, conversationId, {
        kind: 'comment',
        slideId: slide.slideId,
        pageIndex: Number.isInteger(body.pageIndex) ? body.pageIndex : undefined,
        line,
        column: Number.isInteger(body.column) ? body.column : undefined,
        targetLabel: cleanString(body.targetLabel),
        note,
        source: persistSourceMarker ? 'open-slide-comment' : 'open-slide-inspector',
        payload: { commentId, hint: cleanString(body.hint), persistSourceMarker },
      });
      updateProject(db, req.params.id, {});
      res.json({
        comment: {
          id: commentId,
          line,
          note,
          hint: cleanString(body.hint) || undefined,
        },
        feedback,
      });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.delete('/api/projects/:id/open-slide/comments/:commentId', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res);
      if (!slide) return;
      const source = await fs.promises.readFile(slide.file, 'utf8');
      const removed = removeSlideComment(source, req.params.commentId);
      if (!removed.removed) {
        return sendApiError(res, 404, 'BAD_REQUEST', 'comment not found');
      }
      await fs.promises.writeFile(slide.file, removed.source, 'utf8');
      updateProject(db, req.params.id, {});
      res.json({ ok: true, comments: parseSlideComments(removed.source) });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/open-slide/assets', async (req, res) => {
    try {
      const slide = await resolveOpenPptSlideRequest(req, res);
      if (!slide) return;
      const assetsRoot = path.join(path.dirname(slide.file), 'assets');
      if (!fs.existsSync(assetsRoot)) {
        return res.json({ slideId: slide.slideId, assets: [] });
      }
      const names = await fs.promises.readdir(assetsRoot, { withFileTypes: true });
      const assets = names
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const rel = `slides/${slide.slideId}/assets/${entry.name}`;
          return {
            name: entry.name,
            path: rel,
            url: `/api/projects/${encodeURIComponent(req.params.id)}/raw/${rel}`,
          };
        });
      res.json({ slideId: slide.slideId, assets });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  // ---- Tabs -----------------------------------------------------------------

  app.get('/api/projects/:id/tabs', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json(listTabs(db, req.params.id));
  });

  app.put('/api/projects/:id/tabs', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const { tabs = [], active = null } = req.body || {};
    if (!Array.isArray(tabs) || !tabs.every((t) => typeof t === 'string')) {
      return res.status(400).json({ error: 'tabs must be string[]' });
    }
    const result = setTabs(
      db,
      req.params.id,
      tabs,
      typeof active === 'string' ? active : null,
    );
    res.json(result);
  });

  // ---- Templates ----------------------------------------------------------
  // User-saved snapshots of a project's HTML files. Surfaced in the
  // "From template" tab of the new-project panel so a user can spin up
  // a fresh project pre-seeded with another project's design as a
  // starting point. Created via the project's Share menu (snapshots
  // every .html file in the project folder at the moment of save).

  app.get('/api/templates', (_req, res) => {
    res.json({ templates: listTemplates(db) });
  });

  app.get('/api/templates/:id', (req, res) => {
    const t = getTemplate(db, req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({ template: t });
  });

  app.post('/api/templates', async (req, res) => {
    try {
      const { name, description, sourceProjectId } = req.body || {};
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name required' });
      }
      if (typeof sourceProjectId !== 'string') {
        return res.status(400).json({ error: 'sourceProjectId required' });
      }
      if (!getProject(db, sourceProjectId)) {
        return res.status(404).json({ error: 'source project not found' });
      }
      // Snapshot every HTML / sketch / text file in the source project.
      // We deliberately skip binary uploads — templates are about the
      // generated design, not the user's reference imagery.
      const files = await listFiles(PROJECTS_DIR, sourceProjectId);
      const snapshot = [];
      for (const f of files) {
        if (f.kind !== 'html' && f.kind !== 'text' && f.kind !== 'code')
          continue;
        const entry = await readProjectFile(
          PROJECTS_DIR,
          sourceProjectId,
          f.name,
        );
        if (entry && Buffer.isBuffer(entry.buffer)) {
          snapshot.push({
            name: f.name,
            content: entry.buffer.toString('utf8'),
          });
        }
      }
      const t = insertTemplate(db, {
        id: randomId(),
        name: name.trim(),
        description: typeof description === 'string' ? description : null,
        sourceProjectId,
        files: snapshot,
        createdAt: Date.now(),
      });
      res.json({ template: t });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.delete('/api/templates/:id', (req, res) => {
    deleteTemplate(db, req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/agents', async (_req, res) => {
    try {
      const list = await detectAgents();
      res.json({ agents: list });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/skills', async (_req, res) => {
    try {
      const skills = await listSkills(SKILLS_DIR);
      // Strip full body + on-disk dir from the listing — frontend fetches the
      // body via /api/skills/:id when needed (keeps the listing payload small).
      res.json({
        skills: skills.map(({ body, dir: _dir, ...rest }) => ({
          ...rest,
          hasBody: typeof body === 'string' && body.length > 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/skills/:id', async (req, res) => {
    try {
      const skills = await listSkills(SKILLS_DIR);
      const skill = findSkillById(skills, req.params.id);
      if (!skill) return res.status(404).json({ error: 'skill not found' });
      const { dir: _dir, ...serializable } = skill;
      res.json(serializable);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems', async (_req, res) => {
    try {
      const systems = await listDesignSystems(DESIGN_SYSTEMS_DIR);
      res.json({
        designSystems: systems.map(({ body, ...rest }) => rest),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id', async (req, res) => {
    try {
      const body = await readDesignSystem(DESIGN_SYSTEMS_DIR, req.params.id);
      if (body === null)
        return res.status(404).json({ error: 'design system not found' });
      res.json({ id: req.params.id, body });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/prompt-templates', async (_req, res) => {
    try {
      const templates = await listPromptTemplates(PROMPT_TEMPLATES_DIR);
      res.json({
        promptTemplates: templates.map(({ prompt: _prompt, ...rest }) => rest),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/prompt-templates/:surface/:id', async (req, res) => {
    try {
      const tpl = await readPromptTemplate(
        PROMPT_TEMPLATES_DIR,
        req.params.surface,
        req.params.id,
      );
      if (!tpl)
        return res.status(404).json({ error: 'prompt template not found' });
      res.json({ promptTemplate: tpl });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Showcase HTML for a design system — palette swatches, typography
  // samples, sample components, and the full DESIGN.md rendered as prose.
  // Built at request time from the on-disk DESIGN.md so any update to the
  // file shows up on the next view, no rebuild needed.
  app.get('/api/design-systems/:id/preview', async (req, res) => {
    try {
      const body = await readDesignSystem(DESIGN_SYSTEMS_DIR, req.params.id);
      if (body === null)
        return res.status(404).type('text/plain').send('not found');
      const html = renderDesignSystemPreview(req.params.id, body);
      res.type('text/html').send(html);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Marketing-style showcase derived from the same DESIGN.md — full landing
  // page parameterised by the system's tokens. Same lazy-render strategy as
  // /preview: built at request time, no caching.
  app.get('/api/design-systems/:id/showcase', async (req, res) => {
    try {
      const body = await readDesignSystem(DESIGN_SYSTEMS_DIR, req.params.id);
      if (body === null)
        return res.status(404).type('text/plain').send('not found');
      const html = renderDesignSystemShowcase(req.params.id, body);
      res.type('text/html').send(html);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Pre-built example HTML for a skill — what a typical artifact from this
  // skill looks like. Lets users browse skills without running an agent.
  //
  // The skill's `id` (from SKILL.md frontmatter `name`) can differ from its
  // on-disk folder name (e.g. id `magazine-web-ppt` lives in `skills/guizang-ppt/`),
  // so we resolve the actual directory via listSkills() rather than guessing.
  //
  // Resolution order:
  //   1. <skillDir>/example.html — fully-baked static example (preferred)
  //   2. <skillDir>/assets/template.html  +
  //      <skillDir>/assets/example-slides.html — assemble at request time
  //      by replacing the `<!-- SLIDES_HERE -->` marker with the snippet
  //      and patching the placeholder <title>. Lets a skill ship one
  //      canonical seed plus a small content fragment, so the example
  //      never drifts from the seed.
  //   3. <skillDir>/assets/template.html — raw template, no content slides
  //   4. <skillDir>/assets/index.html — generic fallback
  app.get('/api/skills/:id/example', async (req, res) => {
    try {
      const skills = await listSkills(SKILLS_DIR);
      const skill = findSkillById(skills, req.params.id);
      if (!skill) {
        return res.status(404).type('text/plain').send('skill not found');
      }

      const baked = path.join(skill.dir, 'example.html');
      if (fs.existsSync(baked)) {
        const html = await fs.promises.readFile(baked, 'utf8');
        return res
          .type('text/html')
          .send(rewriteSkillAssetUrls(html, skill.id));
      }

      const tpl = path.join(skill.dir, 'assets', 'template.html');
      const slides = path.join(skill.dir, 'assets', 'example-slides.html');
      if (fs.existsSync(tpl) && fs.existsSync(slides)) {
        try {
          const tplHtml = await fs.promises.readFile(tpl, 'utf8');
          const slidesHtml = await fs.promises.readFile(slides, 'utf8');
          const assembled = assembleExample(tplHtml, slidesHtml, skill.name);
          return res
            .type('text/html')
            .send(rewriteSkillAssetUrls(assembled, skill.id));
        } catch {
          // Fall through to raw template on read failure.
        }
      }
      if (fs.existsSync(tpl)) {
        const html = await fs.promises.readFile(tpl, 'utf8');
        return res
          .type('text/html')
          .send(rewriteSkillAssetUrls(html, skill.id));
      }
      const idx = path.join(skill.dir, 'assets', 'index.html');
      if (fs.existsSync(idx)) {
        const html = await fs.promises.readFile(idx, 'utf8');
        return res
          .type('text/html')
          .send(rewriteSkillAssetUrls(html, skill.id));
      }
      res
        .status(404)
        .type('text/plain')
        .send(
          'no example.html, assets/template.html, or assets/index.html for this skill',
        );
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Static assets shipped beside a skill's example/template HTML. Lets the
  // example HTML reference `./assets/foo.png`-style paths that resolve
  // correctly when the response is loaded into a sandboxed `srcdoc` iframe
  // (where relative URLs would otherwise resolve against `about:srcdoc`).
  // The example response above rewrites `./assets/<file>` into a request
  // against this route; we still keep the on-disk paths human-friendly so
  // contributors can preview `example.html` straight from disk.
  app.get('/api/skills/:id/assets/*', async (req, res) => {
    try {
      const skills = await listSkills(SKILLS_DIR);
      const skill = findSkillById(skills, req.params.id);
      if (!skill) {
        return res.status(404).type('text/plain').send('skill not found');
      }
      const relPath = String(req.params[0] || '');
      const assetsRoot = path.resolve(skill.dir, 'assets');
      const target = path.resolve(assetsRoot, relPath);
      if (target !== assetsRoot && !target.startsWith(assetsRoot + path.sep)) {
        return res.status(400).type('text/plain').send('invalid asset path');
      }
      if (!fs.existsSync(target)) {
        return res.status(404).type('text/plain').send('asset not found');
      }
      // The example HTML is rendered inside a sandboxed iframe (Origin: null).
      // Mirror the project /raw route's allowance so the iframe can fetch the
      // image bytes; same-origin web callers do not need this header.
      if (req.headers.origin === 'null') {
        res.header('Access-Control-Allow-Origin', '*');
      }
      res.type(mimeFor(target)).sendFile(target);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.post('/api/upload', upload.array('images', 8), (req, res) => {
    const files = (req.files || []).map((f) => ({
      name: f.originalname,
      path: f.path,
      size: f.size,
    }));
    res.json({ files });
  });

  // Persist a generated artifact (HTML) to disk so the user can re-open it
  // in their browser or hand it off. Returns the on-disk path + a served URL.
  // The body is also passed through the anti-slop linter; findings are
  // returned alongside the path so the UI can render a P0/P1 badge and the
  // chat layer can splice them into a system reminder for the agent.
  app.post('/api/artifacts/save', (req, res) => {
    try {
      const { identifier, title, html } = req.body || {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ error: 'html required' });
      }
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const slug = sanitizeSlug(identifier || title || 'artifact');
      const dir = path.join(ARTIFACTS_DIR, `${stamp}-${slug}`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'index.html');
      fs.writeFileSync(file, html, 'utf8');
      const findings = lintArtifact(html);
      res.json({
        path: file,
        url: `/artifacts/${path.basename(dir)}/index.html`,
        lint: findings,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Standalone lint endpoint — POST raw HTML, get findings back.
  // The chat layer uses this to lint streamed-in artifacts without writing
  // them to disk first, so a P0 issue can be surfaced before save.
  app.post('/api/artifacts/lint', (req, res) => {
    try {
      const { html } = req.body || {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ error: 'html required' });
      }
      const findings = lintArtifact(html);
      res.json({
        findings,
        agentMessage: renderFindingsForAgent(findings),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/live-artifacts', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const artifacts = await listLiveArtifacts({
        projectsRoot: PROJECTS_DIR,
        projectId,
      });
      res.json({ artifacts });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.get('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const variant = typeof req.query.variant === 'string' ? req.query.variant : 'rendered';
      if (variant === 'template' || variant === 'rendered-source') {
        const html = await readLiveArtifactCode({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId: req.params.artifactId,
          variant: variant === 'template' ? 'template' : 'rendered',
        });
        setLiveArtifactCodeHeaders(res);
        return res.status(200).send(html);
      }
      if (variant !== 'rendered') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'variant must be rendered, template, or rendered-source');
      }

      const record = await ensureLiveArtifactPreview({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      setLiveArtifactPreviewHeaders(res);
      res.status(200).send(record.html);
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const record = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ artifact: record.artifact });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId/refreshes', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const refreshes = await listLiveArtifactRefreshLogEntries({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ refreshes });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/create', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:create');
      if (!toolGrant) return;
      const { projectId, input, templateHtml, provenanceJson, createdByRunId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (requestRunOverride(createdByRunId, toolGrant.runId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'createdByRunId is derived from the tool token', {
          details: { suppliedRunId: createdByRunId },
        });
      }

      const record = await createLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
        input: input ?? {},
        templateHtml,
        provenanceJson,
        createdByRunId: toolGrant.runId,
      });
      emitLiveArtifactEvent(toolGrant, 'created', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/tools/live-artifacts/list', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:list');
      if (!toolGrant) return;
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }

      const artifacts = await listLiveArtifacts({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
      });
      res.json({ artifacts });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/update', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:update');
      if (!toolGrant) return;
      const { projectId, artifactId, input, templateHtml, provenanceJson } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }

      const record = await updateLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
        artifactId,
        input: input ?? {},
        templateHtml,
        provenanceJson,
      });
      emitLiveArtifactEvent(toolGrant, 'updated', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/refresh', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:refresh');
      if (!toolGrant) return;
      const { projectId, artifactId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }

      let result;
      try {
        result = await refreshLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId: toolGrant.projectId,
          artifactId,
          onStarted: ({ refreshId }) => {
            emitLiveArtifactRefreshEvent(toolGrant, { phase: 'started', artifactId, refreshId });
          },
        });
      } catch (refreshErr) {
        emitLiveArtifactRefreshEvent(toolGrant, {
          phase: 'failed',
          artifactId,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        throw refreshErr;
      }
      emitLiveArtifactRefreshEvent(toolGrant, {
        phase: 'succeeded',
        artifactId,
        refreshId: result.refresh.id,
        title: result.artifact.title,
        refreshedSourceCount: result.refresh.refreshedSourceCount,
      });
      res.json(result);
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.patch('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const record = await updateLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
        input: req.body ?? {},
      });
      emitLiveArtifactEvent({ projectId }, 'updated', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.delete('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const existing = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      await deleteLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      updateProject(db, projectId, {});
      emitLiveArtifactEvent({ projectId }, 'deleted', existing.artifact);
      res.json({ ok: true });
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.post('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      let result;
      try {
        result = await refreshLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId: req.params.artifactId,
          onStarted: ({ refreshId }) => {
            emitLiveArtifactRefreshEvent({ projectId }, { phase: 'started', artifactId: req.params.artifactId, refreshId });
          },
        });
      } catch (refreshErr) {
        emitLiveArtifactRefreshEvent({ projectId }, {
          phase: 'failed',
          artifactId: req.params.artifactId,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        throw refreshErr;
      }
      emitLiveArtifactRefreshEvent({ projectId }, {
        phase: 'succeeded',
        artifactId: req.params.artifactId,
        refreshId: result.refresh.id,
        title: result.artifact.title,
        refreshedSourceCount: result.refresh.refreshedSourceCount,
      });
      res.json(result);
    } catch (err) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.use('/artifacts', express.static(ARTIFACTS_DIR));

  // ---- Deploy --------------------------------------------------------------

  app.get('/api/deploy/config', async (_req, res) => {
    try {
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = publicDeployConfig(await readVercelConfig());
      res.json(body);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.put('/api/deploy/config', async (req, res) => {
    try {
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = await writeVercelConfig(req.body || {});
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/deployments', (req, res) => {
    try {
      /** @type {import('@open-design/contracts').ProjectDeploymentsResponse} */
      const body = { deployments: listDeployments(db, req.params.id) };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/deploy', async (req, res) => {
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID } = req.body || {};
      if (providerId !== VERCEL_PROVIDER_ID) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'unsupported deploy provider',
        );
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }

      const prior = getDeployment(db, req.params.id, fileName, providerId);
      const files = await buildDeployFileSet(
        PROJECTS_DIR,
        req.params.id,
        fileName,
      );
      const result = await deployToVercel({
        config: await readVercelConfig(),
        files,
        projectId: req.params.id,
      });
      const now = Date.now();
      /** @type {import('@open-design/contracts').DeployProjectFileResponse} */
      const body = upsertDeployment(db, {
        id: prior?.id ?? randomUUID(),
        projectId: req.params.id,
        fileName,
        providerId,
        url: result.url,
        deploymentId: result.deploymentId,
        deploymentCount: (prior?.deploymentCount ?? 0) + 1,
        target: 'preview',
        status: result.status,
        statusMessage: result.statusMessage,
        reachableAt: result.reachableAt,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      });
      res.json(body);
    } catch (err) {
      const status = err instanceof DeployError ? err.status : 400;
      const init =
        err instanceof DeployError && err.details
          ? { details: err.details }
          : {};
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
        init,
      );
    }
  });

  app.post('/api/projects/:id/deploy/preflight', async (req, res) => {
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID } = req.body || {};
      if (providerId !== VERCEL_PROVIDER_ID) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'unsupported deploy provider',
        );
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }
      /** @type {import('@open-design/contracts').DeployPreflightResponse} */
      const body = await prepareDeployPreflight(
        PROJECTS_DIR,
        req.params.id,
        fileName,
      );
      res.json(body);
    } catch (err) {
      // DeployError is a known/expected outcome (validation, missing file).
      // Anything else points at a bug or an unexpected runtime state, so
      // surface it in the daemon log without leaking internals to the
      // client which still gets a generic 400.
      if (!(err instanceof DeployError)) {
        console.error('[deploy/preflight]', err);
      }
      const status = err instanceof DeployError ? err.status : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  app.post(
    '/api/projects/:id/deployments/:deploymentId/check-link',
    async (req, res) => {
      try {
        const existing = getDeploymentById(
          db,
          req.params.id,
          req.params.deploymentId,
        );
        if (!existing) {
          return sendApiError(
            res,
            404,
            'FILE_NOT_FOUND',
            'deployment not found',
          );
        }
        const result = await checkDeploymentUrl(existing.url);
        const now = Date.now();
        /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
        const body = upsertDeployment(db, {
          ...existing,
          status: result.reachable ? 'ready' : result.status || 'link-delayed',
          statusMessage: result.reachable
            ? 'Public link is ready.'
            : result.statusMessage ||
              'Vercel is still preparing the public link.',
          reachableAt: result.reachable ? now : existing.reachableAt,
          updatedAt: now,
        });
        res.json(body);
      } catch (err) {
        sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
      }
    },
  );

  // Shared device frames (iPhone, Android, iPad, MacBook, browser chrome).
  // Skills can compose multi-screen / multi-device layouts by pointing at
  // these files via `<iframe src="/frames/iphone-15-pro.html?screen=...">`.
  // No mtime-based caching — frames are static and small.
  app.use('/frames', express.static(FRAMES_DIR));

  // Project files. Each project owns a flat folder under .od/projects/<id>/
  // containing every file the user has uploaded, pasted, sketched, or that
  // the agent has generated. Names are sanitized; paths are confined to the
  // project's own folder (see apps/daemon/src/projects.ts).
  app.get('/api/projects/:id/files', async (req, res) => {
    try {
      const since = Number(req.query?.since);
      const files = await listFiles(PROJECTS_DIR, req.params.id, {
        since: Number.isFinite(since) ? since : undefined,
      });
      /** @type {import('@open-design/contracts').ProjectFilesResponse} */
      const body = { files };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.get('/api/projects/:id/search', async (req, res) => {
    try {
      const query = String(req.query.q ?? '');
      if (!query) {
        sendApiError(res, 400, 'BAD_REQUEST', 'q query parameter is required');
        return;
      }
      const pattern = req.query.pattern ? String(req.query.pattern) : null;
      const max = Math.min(Number(req.query.max) || 200, 1000);
      const matches = await searchProjectFiles(PROJECTS_DIR, req.params.id, query, {
        pattern,
        max,
      });
      res.json({ query, matches });
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  // Streams a ZIP of the project's on-disk tree so the "Download as .zip"
  // share menu can hand the user the actual files they uploaded — e.g. the
  // imported `ui-design/` folder — instead of a one-file snapshot of the
  // rendered HTML. `root` scopes the archive to a subdirectory; without
  // it, the whole project is packed.
  app.get('/api/projects/:id/archive', async (req, res) => {
    try {
      const root = typeof req.query?.root === 'string' ? req.query.root : '';
      const { buffer, baseName } = await buildProjectArchive(
        PROJECTS_DIR,
        req.params.id,
        root,
      );
      const project = getProject(db, req.params.id);
      const fallbackName = project?.name || req.params.id;
      const fileSlug = sanitizeArchiveFilename(baseName || fallbackName) || 'project';
      const filename = `${fileSlug}.zip`;
      // RFC 5987 dance: legacy `filename=` carries an ASCII fallback, while
      // `filename*=UTF-8''…` lets modern browsers pick up project names
      // with non-ASCII characters (accents, CJK, etc.) without mojibake.
      const asciiFallback =
        filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'project.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(buffer);
    } catch (err) {
      const code = err && err.code;
      const status = code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  // Batch archive: accepts a list of file names and returns a ZIP of just
  // those files. Used by the Design Files panel multi-select download.
  app.post('/api/projects/:id/archive/batch', async (req, res) => {
    try {
      const { files } = req.body || {};
      if (!Array.isArray(files) || files.length === 0) {
        sendApiError(res, 400, 'BAD_REQUEST', 'files must be a non-empty array');
        return;
      }
      const { buffer } = await buildBatchArchive(
        PROJECTS_DIR,
        req.params.id,
        files,
      );
      const project = getProject(db, req.params.id);
      const fileSlug = sanitizeArchiveFilename(project?.name || req.params.id) || 'project';
      const filename = `${fileSlug}.zip`;
      const asciiFallback =
        filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'project.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(buffer);
    } catch (err) {
      const code = err && err.code;
      const status = code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  // Preflight for the raw file route. Current artifact fetches are simple GETs
  // (no preflight needed), but an explicit handler future-proofs the route if
  // artifacts ever add custom request headers.
  app.options('/api/projects/:id/raw/*', (req, res) => {
    if (req.headers.origin === 'null') {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.sendStatus(204);
  });

  app.get('/api/projects/:id/raw/*', async (req, res) => {
    try {
      const relPath = req.params[0];
      const file = await readProjectFile(PROJECTS_DIR, req.params.id, relPath);
      // PreviewModal loads artifact HTML via srcdoc, giving the iframe Origin: "null".
      // data: URIs, file://, and some sandboxed iframes also send null — all are
      // local-only callers, so this is safe. Real cross-origin sites send a real
      // origin and remain blocked by the browser's same-origin policy.
      if (req.headers.origin === 'null') {
        res.header('Access-Control-Allow-Origin', '*');
      }
      res.type(file.mime).send(file.buffer);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  app.delete('/api/projects/:id/raw/*', async (req, res) => {
    try {
      await deleteProjectFile(PROJECTS_DIR, req.params.id, req.params[0]);
      /** @type {import('@open-design/contracts').DeleteProjectFileResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  app.get('/api/projects/:id/files/:name/preview', async (req, res) => {
    try {
      const file = await readProjectFile(
        PROJECTS_DIR,
        req.params.id,
        req.params.name,
      );
      const preview = await buildDocumentPreview(file);
      res.json(preview);
    } catch (err) {
      const status =
        err && err.statusCode
          ? err.statusCode
          : err && err.code === 'ENOENT'
            ? 404
            : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        err?.message || 'preview unavailable',
      );
    }
  });

  app.get('/api/projects/:id/files/*', async (req, res) => {
    try {
      const file = await readProjectFile(
        PROJECTS_DIR,
        req.params.id,
        req.params[0],
      );
      res.type(file.mime).send(file.buffer);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  // Two ways to upload: multipart for binary files (images), and JSON
  // {name, content, encoding} for sketches and pasted text. The frontend
  // uses both depending on the file source.
  app.post(
    '/api/projects/:id/files',
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (err) return sendMulterError(res, err);
        next();
      });
    },
    async (req, res) => {
      try {
        await ensureProject(PROJECTS_DIR, req.params.id);
        if (req.file) {
          const buf = await fs.promises.readFile(req.file.path);
          const desiredName = sanitizeName(
            req.body?.name || req.file.originalname,
          );
          const meta = await writeProjectFile(
            PROJECTS_DIR,
            req.params.id,
            desiredName,
            buf,
          );
          fs.promises.unlink(req.file.path).catch(() => {});
          /** @type {import('@open-design/contracts').ProjectFileResponse} */
          const body = { file: meta };
          return res.json(body);
        }
        const { name, content, encoding, artifactManifest } = req.body || {};
        if (typeof name !== 'string' || typeof content !== 'string') {
          return sendApiError(
            res,
            400,
            'BAD_REQUEST',
            'name and content required',
          );
        }
        if (artifactManifest !== undefined && artifactManifest !== null) {
          const validated = validateArtifactManifestInput(
            artifactManifest,
            name,
          );
          if (!validated.ok) {
            return sendApiError(
              res,
              400,
              'BAD_REQUEST',
              `invalid artifactManifest: ${validated.error}`,
            );
          }
        }
        const buf =
          encoding === 'base64'
            ? Buffer.from(content, 'base64')
            : Buffer.from(content, 'utf8');
        const meta = await writeProjectFile(
          PROJECTS_DIR,
          req.params.id,
          name,
          buf,
          {
            artifactManifest,
          },
        );
        /** @type {import('@open-design/contracts').ProjectFileResponse} */
        const body = { file: meta };
        res.json(body);
      } catch (err) {
        sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
      }
    },
  );

  app.delete('/api/projects/:id/files/:name', async (req, res) => {
    try {
      await deleteProjectFile(PROJECTS_DIR, req.params.id, req.params.name);
      /** @type {import('@open-design/contracts').DeleteProjectFileResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  app.get('/api/media/models', (_req, res) => {
    res.json({
      providers: MEDIA_PROVIDERS,
      image: IMAGE_MODELS,
      video: VIDEO_MODELS,
      audio: AUDIO_MODELS_BY_KIND,
      aspects: MEDIA_ASPECTS,
      videoLengthsSec: VIDEO_LENGTHS_SEC,
      audioDurationsSec: AUDIO_DURATIONS_SEC,
    });
  });

  app.get('/api/media/config', async (_req, res) => {
    try {
      const cfg = await readMaskedConfig(PROJECT_ROOT);
      res.json(cfg);
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/media/config', async (req, res) => {
    try {
      const cfg = await writeConfig(PROJECT_ROOT, req.body);
      res.json(cfg);
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      res
        .status(status)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.get('/api/codex-image-proxy/status', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const reportHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      res.json(await getCodexImageProxyStatus(`http://${reportHost}:${resolvedPort}`));
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/v1/images/generations', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({
        error: {
          message: 'cross-origin request rejected: Codex image proxy is restricted to local clients',
          type: 'permission_error',
          code: 'forbidden',
        },
      });
    }
    return handleCodexImageGenerationsRequest(req, res, {
      projectRoot: PROJECT_ROOT,
    });
  });

  app.get('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      res.json({ config });
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await writeAppConfig(RUNTIME_DATA_DIR, req.body);
      res.json({ config });
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  // Native OS folder picker dialog. Returns { path: string | null }.
  app.post('/api/dialog/open-folder', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const selected = await openNativeFolderDialog();
      res.json({ path: selected });
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/projects/:id/media/generate', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({
        error:
          'cross-origin request rejected: media generation is restricted to the local UI / CLI',
      });
    }

    try {
      const projectId = req.params.id;
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });
      const effectiveMetadata =
        req.body?.surface === 'image'
          ? await metadataWithVaultTemplateFromDesignSystem(project.metadata, project.designSystemId)
          : project.metadata;
      const vaultAgentContextBody =
        req.body?.surface === 'image'
          ? await readVaultAgentContextBody(effectiveMetadata, project.designSystemId)
          : undefined;
      const mediaPrompt = enhanceOpenPptMediaPrompt({
        surface: req.body?.surface,
        prompt: req.body?.prompt,
        output: req.body?.output,
        projectMetadata: effectiveMetadata,
        designSystemId: project.designSystemId,
        vaultAgentContextBody,
      });

      const taskId = randomUUID();
      const task = createMediaTask(taskId, projectId, {
        surface: req.body?.surface,
        model: req.body?.model,
      });
      console.error(
        `[task ${taskId.slice(0, 8)}] queued model=${req.body?.model} ` +
          `surface=${req.body?.surface} ` +
          `image=${req.body?.image ? 'yes' : 'no'} ` +
          `compositionDir=${req.body?.compositionDir ? 'yes' : 'no'}`,
      );

      task.status = 'running';
      generateMedia({
        projectRoot: PROJECT_ROOT,
        projectsRoot: PROJECTS_DIR,
        projectId,
        surface: req.body?.surface,
        model: req.body?.model,
        prompt: mediaPrompt,
        output: req.body?.output,
        aspect: req.body?.aspect,
        length:
          typeof req.body?.length === 'number' ? req.body.length : undefined,
        duration:
          typeof req.body?.duration === 'number'
            ? req.body.duration
            : undefined,
        voice: req.body?.voice,
        audioKind: req.body?.audioKind,
        compositionDir: req.body?.compositionDir,
        image: req.body?.image,
        onProgress: (line) => appendTaskProgress(task, line),
      })
        .then((meta) => {
          task.status = 'done';
          task.file = meta;
          task.endedAt = Date.now();
          notifyTaskWaiters(task);
          console.error(
            `[task ${taskId.slice(0, 8)}] done size=${meta?.size} mime=${meta?.mime} ` +
              `elapsed=${Math.round((task.endedAt - task.startedAt) / 1000)}s`,
          );
        })
        .catch((err) => {
          task.status = 'failed';
          task.error = {
            message: String(err && err.message ? err.message : err),
            status: typeof err?.status === 'number' ? err.status : 400,
            code: err?.code,
          };
          task.endedAt = Date.now();
          notifyTaskWaiters(task);
          console.error(
            `[task ${taskId.slice(0, 8)}] failed status=${task.error.status} ` +
              `message=${(task.error.message || '').slice(0, 240)}`,
          );
        });

      res.status(202).json({
        taskId,
        status: task.status,
        startedAt: task.startedAt,
      });
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/media/tasks/:id/wait', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const taskId = req.params.id;
    const task = mediaTasks.get(taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });

    const since = Number.isFinite(req.body?.since) ? Number(req.body.since) : 0;
    const requestedTimeout = Number.isFinite(req.body?.timeoutMs)
      ? Number(req.body.timeoutMs)
      : 25_000;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 0), 25_000);

    const respond = () => {
      if (res.writableEnded) return;
      const snapshot = {
        taskId,
        status: task.status,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        progress: task.progress.slice(since),
        nextSince: task.progress.length,
      };
      if (task.status === 'done') snapshot.file = task.file;
      if (task.status === 'failed') snapshot.error = task.error;
      res.json(snapshot);
    };

    if (
      task.status === 'done' ||
      task.status === 'failed' ||
      task.progress.length > since
    ) {
      return respond();
    }

    let resolved = false;
    const wake = () => {
      if (resolved) return;
      resolved = true;
      task.waiters.delete(wake);
      clearTimeout(timer);
      respond();
    };
    task.waiters.add(wake);
    const timer = setTimeout(wake, timeoutMs);
    res.on('close', wake);
  });

  app.get('/api/projects/:id/media/tasks', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const projectId = req.params.id;
    const includeDone =
      req.query.includeDone === '1' || req.query.includeDone === 'true';
    const tasks = [];
    for (const t of mediaTasks.values()) {
      if (t.projectId !== projectId) continue;
      const isTerminal = t.status === 'done' || t.status === 'failed';
      if (isTerminal && !includeDone) continue;
      tasks.push({
        taskId: t.id,
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        elapsed: Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000),
        surface: t.surface,
        model: t.model,
        progress: t.progress.slice(-3),
        progressCount: t.progress.length,
        ...(t.status === 'done' ? { file: t.file } : {}),
        ...(t.status === 'failed' ? { error: t.error } : {}),
      });
    }
    tasks.sort((a, b) => b.startedAt - a.startedAt);
    res.json({ tasks });
  });

  // Multi-file upload that the chat composer uses for paste/drop/picker.
  // Files land flat in the project folder; the response carries the same
  // metadata as listFiles so the client can stage them as ChatAttachments
  // without a separate refetch.
  app.post(
    '/api/projects/:id/upload',
    handleProjectUpload,
    async (req, res) => {
      try {
        const incoming = Array.isArray(req.files) ? req.files : [];
        const out = [];
        for (const f of incoming) {
          try {
            const stat = await fs.promises.stat(f.path);
            out.push({
              name: f.filename,
              path: f.filename,
              size: stat.size,
              mtime: stat.mtimeMs,
              originalName: f.originalname,
            });
          } catch {
            // skip files that vanished mid-flight
          }
        }
        /** @type {import('@open-design/contracts').UploadProjectFilesResponse} */
        const body = { files: out };
        res.json(body);
      } catch (err) {
        sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
      }
    },
  );

  const design = {
    runs: createChatRunService({
      createSseResponse,
      createSseErrorPayload,
      idleTimeoutMs: CHAT_RUN_IDLE_TIMEOUT_MS,
      cancelGraceMs: CHAT_RUN_CANCEL_GRACE_MS,
    }),
  };

  const composeDaemonSystemPrompt = async ({
    projectId,
    skillId,
    designSystemId,
  }) => {
    const project =
      typeof projectId === 'string' && projectId
        ? getProject(db, projectId)
        : null;
    const effectiveSkillId =
      typeof skillId === 'string' && skillId ? skillId : project?.skillId;
    const effectiveDesignSystemId =
      typeof designSystemId === 'string' && designSystemId
        ? designSystemId
        : project?.designSystemId;
    const metadata = await metadataWithVaultTemplateFromDesignSystem(
      project?.metadata,
      effectiveDesignSystemId,
    );

    let skillBody;
    let skillName;
    let skillMode;
    let skillCraftRequires = [];
    let activeSkillDir = null;
    if (effectiveSkillId) {
      const skill = findSkillById(
        await listSkills(SKILLS_DIR),
        effectiveSkillId,
      );
      if (skill) {
        skillBody = skill.body;
        skillName = skill.name;
        skillMode = skill.mode;
        activeSkillDir = skill.dir;
        if (Array.isArray(skill.craftRequires))
          skillCraftRequires = skill.craftRequires;
      }
    }

    let craftBody;
    let craftSections;
    if (skillCraftRequires.length > 0) {
      const loaded = await loadCraftSections(CRAFT_DIR, skillCraftRequires);
      if (loaded.body) {
        craftBody = loaded.body;
        craftSections = loaded.sections;
      }
    }

    let designSystemBody;
    let designSystemTitle;
    if (effectiveDesignSystemId) {
      const systems = await listDesignSystems(DESIGN_SYSTEMS_DIR);
      const summary = systems.find((s) => s.id === effectiveDesignSystemId);
      designSystemTitle = summary?.title;
      designSystemBody =
        (await readDesignSystem(DESIGN_SYSTEMS_DIR, effectiveDesignSystemId)) ??
        undefined;
    }

    const template =
      metadata?.kind === 'template' && typeof metadata.templateId === 'string'
        ? (getTemplate(db, metadata.templateId) ?? undefined)
        : undefined;
    const vaultTemplateBody = await readVaultOpenSlideTheme(metadata, effectiveDesignSystemId);
    const vaultAgentContextBody = await readVaultAgentContextBody(metadata, effectiveDesignSystemId);
    const vaultCatalogBody = await readVaultCatalogForPrompt(metadata);

    const prompt = composeSystemPrompt({
      skillBody,
      skillName,
      skillMode,
      designSystemBody,
      designSystemTitle,
      craftBody,
      craftSections,
      metadata,
      vaultTemplateBody,
      vaultAgentContextBody,
      vaultCatalogBody,
      template,
    });
    // The chat handler also needs to know where the active skill lives
    // on disk so it can stage a per-project copy of its side files
    // before spawning the agent. Returning that here avoids a second
    // `listSkills()` scan in `startChatRun`.
    return { prompt, activeSkillDir };
  };

  const startChatRun = async (chatBody, run) => {
    /** @type {Partial<ChatRequest> & { imagePaths?: string[] }} */
    chatBody = chatBody || {};
    const {
      agentId,
      message,
      systemPrompt,
      imagePaths = [],
      projectId,
      conversationId,
      assistantMessageId,
      clientRequestId,
      skillId,
      designSystemId,
      attachments = [],
      commentAttachments = [],
      slideFeedbackAttachments = [],
      vaultContextAttachments = [],
      model,
      reasoning,
    } = chatBody;
    if (typeof projectId === 'string' && projectId) run.projectId = projectId;
    if (typeof conversationId === 'string' && conversationId)
      run.conversationId = conversationId;
    if (typeof assistantMessageId === 'string' && assistantMessageId)
      run.assistantMessageId = assistantMessageId;
    if (typeof clientRequestId === 'string' && clientRequestId)
      run.clientRequestId = clientRequestId;
    if (typeof agentId === 'string' && agentId) run.agentId = agentId;
    const def = getAgentDef(agentId);
    if (!def)
      return design.runs.fail(
        run,
        'AGENT_UNAVAILABLE',
        `unknown agent: ${agentId}`,
      );
    if (!def.bin)
      return design.runs.fail(run, 'AGENT_UNAVAILABLE', 'agent has no binary');
    const safeCommentAttachments =
      normalizeCommentAttachments(commentAttachments);
    const safeSlideFeedbackAttachments =
      normalizeSlideFeedbackAttachments(slideFeedbackAttachments);
    const safeVaultContextAttachments =
      normalizeVaultContextAttachments(vaultContextAttachments);
    if (
      (typeof message !== 'string' || !message.trim()) &&
      safeCommentAttachments.length === 0 &&
      safeSlideFeedbackAttachments.length === 0 &&
      safeVaultContextAttachments.length === 0
    ) {
      return design.runs.fail(run, 'BAD_REQUEST', 'message required');
    }
    if (run.cancelRequested || design.runs.isTerminal(run.status)) return;
    const runId = run.id;

    // Resolve the project working directory (creating the folder if it
    // doesn't exist yet). Without one we don't pass cwd to spawn — the
    // agent then runs in whatever inherited dir, which still lets API
    // mode work but loses file-tool addressability.
    let cwd = null;
    let existingProjectFiles = [];
    if (typeof projectId === 'string' && projectId) {
      try {
        cwd = await ensureProject(PROJECTS_DIR, projectId);
        existingProjectFiles = await listFiles(PROJECTS_DIR, projectId);
      } catch {
        cwd = null;
      }
    }
    if (run.cancelRequested || design.runs.isTerminal(run.status)) return;

    // Sanitise supplied image paths: must live under UPLOAD_DIR.
    const safeImages = imagePaths.filter((p) => {
      const resolved = path.resolve(p);
      return (
        resolved.startsWith(UPLOAD_DIR + path.sep) && fs.existsSync(resolved)
      );
    });

    // Project-scoped attachments: project-relative paths inside cwd. Each
    // is run through the same path-traversal guard the file CRUD endpoints
    // use, then existence-checked. Whatever survives shows up as an
    // explicit list at the bottom of the user message so the agent knows
    // to Read it.
    const safeAttachments = cwd
      ? (Array.isArray(attachments) ? attachments : [])
          .filter((p) => typeof p === 'string' && p.length > 0)
          .filter((p) => {
            try {
              const abs = path.resolve(cwd, p);
              return (
                (abs === cwd || abs.startsWith(cwd + path.sep)) &&
                fs.existsSync(abs)
              );
            } catch {
              return false;
            }
          })
      : [];

    // Local code agents don't accept a separate "system" channel the way the
    // Messages API does — we fold the skill + design-system prompt into the
    // user message. The <artifact> wrapping instruction comes from
    // systemPrompt. We also stitch in the cwd hint so the agent knows
    // where its file tools should write, and the attachment list so it
    // doesn't have to guess what the user just dropped in.
    // Also ship the current file listing so the agent can pick a unique
    // filename instead of clobbering a previous artifact.
    const filesListBlock = existingProjectFiles.length
      ? `\nFiles already in this folder (do NOT overwrite unless the user asks; pick a fresh, descriptive name for new artifacts):\n${existingProjectFiles
          .map((f) => `- ${f.name}`)
          .join('\n')}`
      : '\nThis folder is empty. Choose a clear, descriptive filename for whatever you create.';
    const projectRecord =
      typeof projectId === 'string' && projectId
        ? getProject(db, projectId)
        : null;
    const linkedDirs = (() => {
      if (!Array.isArray(projectRecord?.metadata?.linkedDirs)) return [];
      const v = validateLinkedDirs(projectRecord.metadata.linkedDirs);
      return v.dirs ?? [];
    })();
    const cwdHint = cwd
      ? `\n\nYour working directory: ${cwd}\nWrite project files relative to it (e.g. \`index.html\`, \`assets/x.png\`). The user can browse those files in real time.${filesListBlock}`
      : '';
    const linkedDirsHint = linkedDirs.length > 0
      ? `\n\nLinked code folders (read-only reference code the user wants you to see):\n${
          linkedDirs.map((d) => `- \`${d}\``).join('\n')
        }`
      : '';
    const attachmentHint = safeAttachments.length
      ? `\n\nAttached project files: ${safeAttachments.map((p) => `\`${p}\``).join(', ')}`
      : '';
    const toolTokenGrant = cwd && typeof projectId === 'string' && projectId
      ? toolTokenRegistry.mint({
          runId,
          projectId,
          allowedEndpoints: CHAT_TOOL_ENDPOINTS,
          allowedOperations: CHAT_TOOL_OPERATIONS,
        })
      : null;
    let toolTokenRevoked = false;
    const revokeToolToken = (reason) => {
      if (toolTokenRevoked || !toolTokenGrant) return;
      toolTokenRevoked = true;
      toolTokenRegistry.revokeToken(toolTokenGrant.token, reason);
    };
    const runtimeToolPrompt = createAgentRuntimeToolPrompt(daemonUrl, toolTokenGrant);
    const commentHint = renderCommentAttachmentHint(safeCommentAttachments);
    const slideFeedbackHint = renderSlideFeedbackAttachmentHint(
      safeSlideFeedbackAttachments,
    );
    const vaultContextHint = renderVaultContextAttachmentHint(
      safeVaultContextAttachments,
    );
    const { prompt: daemonSystemPrompt, activeSkillDir } =
      await composeDaemonSystemPrompt({
        projectId,
        skillId,
        designSystemId,
      });
    const vaultContextAttachmentPrompt = await readVaultContextAttachmentsBody(
      safeVaultContextAttachments,
    );
    const instructionPrompt = [daemonSystemPrompt, vaultContextAttachmentPrompt, runtimeToolPrompt, systemPrompt]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join('\n\n---\n\n');
    const composed = [
      instructionPrompt
        ? `# Instructions (read first)\n\n${instructionPrompt}${cwdHint}${linkedDirsHint}\n\n---\n`
        : cwdHint
          ? `# Instructions${cwdHint}${linkedDirsHint}\n\n---\n`
          : linkedDirsHint
            ? `# Instructions${linkedDirsHint}\n\n---\n`
            : '',
      `# User request\n\n${message || '(No extra typed instruction.)'}${attachmentHint}${vaultContextHint}${commentHint}${slideFeedbackHint}`,
      safeImages.length
        ? `\n\n${safeImages.map((p) => `@${p}`).join(' ')}`
        : '',
    ].join('');

    // Make skill side files reachable through three layers, in order of
    // preference. The skill preamble emitted by `withSkillRootPreamble()`
    // advertises both the cwd-relative path (1) and the absolute path
    // (2/3) so the agent can pick whichever works.
    //
    //   1. CWD-relative copy. Stage the *active* skill into
    //      `<cwd>/.od-skills/<folder>/` so any agent CLI — not just the
    //      ones that honour `--add-dir` — can reach those files via a
    //      path inside its working directory. We copy (not symlink) so
    //      the staged directory is a true write barrier — agents cannot
    //      mutate the shipped repo resource through their cwd.
    //   2. `--add-dir` allowlist. Pass `SKILLS_DIR` and
    //      `DESIGN_SYSTEMS_DIR` to Claude/Copilot so the absolute fallback
    //      path in the preamble is reachable when staging fails (e.g. the
    //      project has no on-disk cwd, or fs.cp errored).
    //   3. PROJECT_ROOT cwd. When `cwd` is null, the agent runs with
    //      `cwd: PROJECT_ROOT` — there the absolute path is already an
    //      in-cwd path, so neither (1) nor (2) is required for it to
    //      resolve.
    //
    // Design systems are *not* staged here. Their bodies are read by the
    // daemon and folded into the system prompt directly (see
    // `readDesignSystem`), so an agent never has to open them via the
    // filesystem.
    if (cwd && activeSkillDir) {
      const result = await stageActiveSkill(
        cwd,
        path.basename(activeSkillDir),
        activeSkillDir,
        (msg) => console.warn(msg),
      );
      if (!result.staged) {
        console.warn(
          `[od] skill-stage skipped: ${result.reason ?? 'unknown reason'}; falling back to absolute paths`,
        );
      }
    }
    // Resolve the agent's effective working directory once and use it
    // everywhere the agent could read it (buildArgs runtimeContext, spawn
    // cwd, ACP session new). Falling back to PROJECT_ROOT — rather than
    // letting `spawn` inherit the daemon process cwd — is what makes the
    // absolute-path fallback in the skill preamble actually in-cwd for
    // no-project runs (packaged daemons / service launches do not start
    // their working directory from the workspace root).
    const effectiveCwd = cwd ?? PROJECT_ROOT;
    const extraAllowedDirs = [
      SKILLS_DIR,
      DESIGN_SYSTEMS_DIR,
      ...linkedDirs,
    ].filter((d) => fs.existsSync(d));
    // Per-agent model + reasoning the user picked in the model menu.
    // Trust the value when it matches the most recent /api/agents listing
    // (live or fallback). Otherwise allow it through if it passes a
    // permissive sanitizer — that's the path for user-typed custom model
    // ids the CLI's listing didn't surface yet.
    const safeModel =
      typeof model === 'string'
        ? isKnownModel(def, model)
          ? model
          : sanitizeCustomModel(model)
        : null;
    const normalizedModel = normalizeAgentModelChoice(agentId, safeModel);
    const safeReasoning =
      typeof reasoning === 'string' && Array.isArray(def.reasoningOptions)
        ? (def.reasoningOptions.find((r) => r.id === reasoning)?.id ?? null)
        : null;
    const agentOptions = { model: normalizedModel, reasoning: safeReasoning };
    const mcpServers = buildLiveArtifactsMcpServersForAgent(def, {
      enabled: Boolean(toolTokenGrant?.token),
      command: process.execPath,
      argsPrefix: [OD_BIN],
    });

    // Pre-flight the composed prompt against any argv-byte budget the
    // adapter declared (only DeepSeek TUI today — its CLI doesn't accept
    // a `-` stdin sentinel, so the prompt has to ride argv). Doing this
    // before bin resolution means the test harness pins the guard
    // independently of whether the adapter binary happens to be on PATH
    // in the CI environment, and the user gets the actionable
    // adapter-named error even if /api/agents hadn't refreshed yet.
    const promptBudgetError = checkPromptArgvBudget(def, composed);
    if (promptBudgetError) {
      design.runs.emit(
        run,
        'error',
        createSseErrorPayload(
          promptBudgetError.code,
          promptBudgetError.message,
          { retryable: false },
        ),
      );
      return design.runs.finish(run, 'failed', 1, null);
    }

    const resolvedBin = resolveAgentBin(agentId);

    const args = def.buildArgs(
      composed,
      safeImages,
      extraAllowedDirs,
      agentOptions,
      { cwd: effectiveCwd },
    );

    // Second-pass budget check that knows about the Windows `.cmd` shim
    // wrap. The pre-buildArgs `checkPromptArgvBudget` only looks at the
    // raw composed prompt; on Windows an npm-installed adapter resolves
    // to e.g. `deepseek.cmd`, the spawn path goes through `cmd.exe /d /s
    // /c "<inner>"`, and `quoteForWindowsCmdShim` doubles every embedded
    // `"` plus wraps any whitespace/special-char arg in outer quotes —
    // so a quote-heavy prompt that fit under `maxPromptArgBytes` can
    // still expand past CreateProcess's 32_767-char cap. Fail fast with
    // the same `AGENT_PROMPT_TOO_LARGE` shape so the SSE error path
    // doesn't have to special-case it.
    const cmdShimBudgetError = checkWindowsCmdShimCommandLineBudget(
      def,
      resolvedBin,
      args,
    );
    if (cmdShimBudgetError) {
      design.runs.emit(
        run,
        'error',
        createSseErrorPayload(
          cmdShimBudgetError.code,
          cmdShimBudgetError.message,
          { retryable: false },
        ),
      );
      return design.runs.finish(run, 'failed', 1, null);
    }

    // Companion guard for non-shim Windows installs (e.g. a cargo-built
    // `deepseek.exe` rather than the npm `.cmd` shim). Direct `.exe`
    // spawns skip the cmd.exe wrap above, but Node/libuv still composes
    // a CreateProcess `lpCommandLine` by walking each argv element
    // through `quote_cmd_arg`, which escapes every embedded `"` as `\"`
    // and doubles backslashes adjacent to quotes. A quote-heavy prompt
    // under `maxPromptArgBytes` can expand past the 32_767-char kernel
    // cap there too, so the cmd-shim early-return alone would let those
    // users hit a generic `spawn ENAMETOOLONG`.
    const directExeBudgetError = checkWindowsDirectExeCommandLineBudget(
      def,
      resolvedBin,
      args,
    );
    if (directExeBudgetError) {
      design.runs.emit(
        run,
        'error',
        createSseErrorPayload(
          directExeBudgetError.code,
          directExeBudgetError.message,
          { retryable: false },
        ),
      );
      return design.runs.finish(run, 'failed', 1, null);
    }

    const send = (event, data) => design.runs.emit(run, event, data);
    const unregisterChatAgentEventSink = () => {
      activeChatAgentEventSinks.delete(toolTokenGrant?.runId ?? runId);
    };
    if (toolTokenGrant?.runId) {
      activeChatAgentEventSinks.set(toolTokenGrant.runId, (payload) =>
        send('agent', payload),
      );
    }
    // If detection can't find the binary, surface a friendly SSE error
    // pointing at /api/agents instead of silently falling back to
    // spawn(def.bin) — that fallback re-introduces the exact ENOENT symptom
    // from issue #10.
    if (!resolvedBin) {
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      send('error', createSseErrorPayload(
        'AGENT_UNAVAILABLE',
        `Agent "${def.name}" (\`${def.bin}\`) is not installed or not on PATH. ` +
          'Install it and refresh the agent list (GET /api/agents) before retrying.',
        { retryable: true },
      ));
      return design.runs.finish(run, 'failed', 1, null);
    }
    const odMediaEnv = {
      OD_BIN,
      OD_NODE_BIN,
      OD_DAEMON_URL: daemonUrl,
      ...(typeof projectId === 'string' && projectId && cwd
        ? {
            OD_PROJECT_ID: projectId,
            OD_PROJECT_DIR: cwd,
          }
        : {}),
    };

    if (run.cancelRequested || design.runs.isTerminal(run.status)) {
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      return;
    }

    run.status = 'running';
    run.updatedAt = Date.now();
    send('start', {
      runId,
      agentId,
      bin: resolvedBin,
      streamFormat: def.streamFormat ?? 'plain',
      projectId: typeof projectId === 'string' ? projectId : null,
      cwd,
      model: safeModel,
      reasoning: safeReasoning,
      toolTokenExpiresAt: toolTokenGrant?.expiresAt ?? null,
    });

    let child;
    let acpSession = null;
    try {
      // Prompt delivery via stdin is now the universal default. This bypasses
      // both the cmd.exe 8KB limit and the CreateProcess 32KB limit.
      const stdinMode =
        def.promptViaStdin || def.streamFormat === 'acp-json-rpc'
          ? 'pipe'
          : 'ignore';
      const env = {
        ...spawnEnvForAgent(
          def.id,
          {
            ...createAgentRuntimeEnv(process.env, daemonUrl, toolTokenGrant),
            ...(def.env || {}),
          },
        ),
        ...odMediaEnv,
      };
      const invocation = createCommandInvocation({
        command: resolvedBin,
        args,
        env,
      });
      child = spawn(invocation.command, invocation.args, {
        env,
        stdio: [stdinMode, 'pipe', 'pipe'],
        cwd: effectiveCwd,
        shell: false,
        detached: process.platform !== 'win32',
        // Required when invocation wraps a Windows .cmd/.bat shim through
        // cmd.exe; without this, Node re-escapes the inner command line and
        // breaks paths containing spaces (issue #315).
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      run.child = child;
      if (def.promptViaStdin && child.stdin && def.streamFormat !== 'pi-rpc') {
        // EPIPE from a fast-exiting CLI (bad auth, missing model, exit on
        // launch) would otherwise surface as an unhandled stream error and
        // crash the daemon. Swallow it — the regular exit/close handlers
        // below already route the underlying failure to SSE via stderr.
        child.stdin.on('error', (err) => {
          if (err.code !== 'EPIPE') {
            send(
              'error',
              createSseErrorPayload(
                'AGENT_EXECUTION_FAILED',
                `stdin: ${err.message}`,
              ),
            );
          }
        });
        child.stdin.end(composed, 'utf8');
      }
    } catch (err) {
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', `spawn failed: ${err.message}`));
      design.runs.finish(run, 'failed', 1, null);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // Critique Theater branch (M0 dark launch, default disabled).
    // Only plain-stream adapters are routed through runOrchestrator in v1.
    // Adapters that emit structured wrappers (claude-stream-json,
    // copilot-stream-json, json-event-stream, acp-json-rpc, pi-rpc) fall
    // through to the legacy single-pass code path below with a one-time
    // stderr warning so the parser never sees wrapper bytes. Per-format
    // decoding into the orchestrator is a v2 concern.
    if (critiqueCfg.enabled) {
      const adapterStreamFormat: string = def.streamFormat ?? 'plain';
      if (adapterStreamFormat !== 'plain') {
        if (!critiqueWarnedAdapters.has(adapterStreamFormat)) {
          critiqueWarnedAdapters.add(adapterStreamFormat);
          console.warn(`[critique] adapter format=${adapterStreamFormat} is not plain-stream; skipping orchestrator and falling through to legacy generation`);
        }
      } else {
        const critiqueRunId = run.id;
        // Per-run artifact directory keeps concurrent or sequential runs in the
        // same project from overwriting each other's transcript or final HTML.
        // Spec: artifacts/<projectId>/<runId>/transcript.ndjson(.gz).
        const critiqueProjectKey = typeof projectId === 'string' && projectId ? projectId : critiqueRunId;
        const critiqueArtifactDir = path.join(ARTIFACTS_DIR, critiqueProjectKey, critiqueRunId);
        const stdoutIterable = (async function* () {
          for await (const chunk of child.stdout) yield String(chunk);
        })();
        const critiqueBus = { emit: (e) => send('agent', e) };

        // Stderr forwarding and child.on('error') must be wired BEFORE the
        // orchestrator awaits stdout. Otherwise a CLI that floods stderr can
        // fill the OS pipe and deadlock the run until the total timeout, and
        // an early child error fired before the orchestrator returns has no
        // listener. Both registrations are idempotent and the run lifecycle
        // is owned solely by the orchestrator's awaited result below.
        child.stderr.on('data', (chunk) => send('stderr', { chunk }));
        child.on('error', (err) => {
          send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', err.message));
        });

        // Wrap the child's close event so the orchestrator can race child
        // exit against parser completion, abort, and timeouts in one awaited
        // flow. Without this the orchestrator can't tell a non-zero exit
        // apart from a clean ship and may misclassify failures.
        const childExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        try {
          const orchestratorResult = await runOrchestrator({
            runId: critiqueRunId,
            projectId: typeof projectId === 'string' ? projectId : '',
            conversationId: typeof conversationId === 'string' ? conversationId : null,
            artifactId: critiqueRunId,
            artifactDir: critiqueArtifactDir,
            adapter: typeof agentId === 'string' ? agentId : 'unknown',
            cfg: critiqueCfg,
            db,
            bus: critiqueBus,
            stdout: stdoutIterable,
            child,
            childExitPromise,
          });
          // Map the critique terminal status to the chat run lifecycle.
          // 'shipped' and 'below_threshold' both ran to a ship decision and
          // finalize as 'succeeded'; every other status (timed_out,
          // interrupted, degraded, failed, legacy) is a failure path so the
          // run reflects the real outcome instead of a misleading success.
          const succeeded = orchestratorResult.status === 'shipped'
            || orchestratorResult.status === 'below_threshold';
          if (run.cancelRequested) {
            design.runs.finish(run, 'canceled', 1, null);
          } else if (succeeded) {
            design.runs.finish(run, 'succeeded', 0, null);
          } else {
            design.runs.finish(run, 'failed', 1, null);
          }
        } catch (err) {
          send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', err instanceof Error ? err.message : String(err)));
          design.runs.finish(run, 'failed', 1, null);
        }
        return;
      }
    }

    // Structured streams (Claude Code) go through a line-delimited JSON
    // parser that turns stream_event objects into UI-friendly events. For
    // plain streams (most other CLIs) we forward raw chunks unchanged so
    // the browser can append them to the assistant's text buffer.
    if (def.streamFormat === 'claude-stream-json') {
      const claude = createClaudeStreamHandler((ev) => send('agent', ev));
      child.stdout.on('data', (chunk) => claude.feed(chunk));
      child.on('close', () => claude.flush());
    } else if (def.streamFormat === 'copilot-stream-json') {
      const copilot = createCopilotStreamHandler((ev) => send('agent', ev));
      child.stdout.on('data', (chunk) => copilot.feed(chunk));
      child.on('close', () => copilot.flush());
    } else if (def.streamFormat === 'pi-rpc') {
      acpSession = attachPiRpcSession({
        child,
        prompt: composed,
        cwd: effectiveCwd,
        model: safeModel,
        send,
      });
    } else if (def.streamFormat === 'acp-json-rpc') {
      acpSession = attachAcpSession({
        child,
        prompt: composed,
        cwd: effectiveCwd,
        model: safeModel,
        mcpServers,
        send,
      });
    } else if (def.streamFormat === 'json-event-stream') {
      const handler = createJsonEventStreamHandler(
        def.eventParser || def.id,
        (ev) => send('agent', ev),
      );
      child.stdout.on('data', (chunk) => handler.feed(chunk));
      child.on('close', () => handler.flush());
    } else {
      child.stdout.on('data', (chunk) => send('stdout', { chunk }));
    }
    child.stderr.on('data', (chunk) => send('stderr', { chunk }));

    child.on('error', (err) => {
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', err.message));
      design.runs.finish(run, 'failed', 1, null);
    });
    child.on('close', (code, signal) => {
      revokeToolToken('child_exit');
      unregisterChatAgentEventSink();
      if (acpSession?.hasFatalError()) {
        return design.runs.finish(run, 'failed', code ?? 1, signal ?? null);
      }
      const status = run.cancelRequested
        ? 'canceled'
        : code === 0
          ? 'succeeded'
          : 'failed';
      design.runs.finish(run, status, code, signal);
    });
  };

  app.post('/api/runs', (req, res) => {
    const run = design.runs.create(req.body || {});
    /** @type {import('@open-design/contracts').ChatRunCreateResponse} */
    const body = { runId: run.id };
    res.status(202).json(body);
    design.runs.start(run, () => startChatRun(req.body || {}, run));
  });

  app.get('/api/runs', (req, res) => {
    const { projectId, conversationId, status } = req.query;
    const runs = design.runs.list({ projectId, conversationId, status });
    /** @type {import('@open-design/contracts').ChatRunListResponse} */
    const body = { runs: runs.map(design.runs.statusBody) };
    res.json(body);
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    res.json(design.runs.statusBody(run));
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    design.runs.stream(run, req, res);
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    design.runs.cancel(run);
    /** @type {import('@open-design/contracts').ChatRunCancelResponse} */
    const body = { ok: true };
    res.json(body);
  });

  app.post('/api/chat', (req, res) => {
    const run = design.runs.create();
    design.runs.stream(run, req, res);
    design.runs.start(run, () => startChatRun(req.body || {}, run));
  });

  // ---- API Proxy (SSE) for API-compatible endpoints ------------------------
  // Browser → daemon → external API. Avoids CORS issues with third-party
  // providers. This keeps BYOK setup zero-config for local users at the cost of
  // one local streaming hop through the daemon.

  const redactAuthTokens = (text) =>
    text.replace(/Bearer [A-Za-z0-9_\-.+/=]+/g, 'Bearer [REDACTED]');

  const validateExternalApiBaseUrl = (baseUrl) => {
    let parsed;
    try {
      parsed = new URL(baseUrl.replace(/\/+$/, ''));
    } catch {
      return { error: 'Invalid baseUrl' };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { error: 'Only http/https allowed' };
    }
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback =
      ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    if (
      !isLoopback &&
      (hostname.startsWith('169.254.') ||
        hostname.startsWith('10.') ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname))
    ) {
      return { error: 'Internal IPs blocked', forbidden: true };
    }
    return { parsed };
  };

  const proxyErrorCode = (status) => {
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    return 'UPSTREAM_UNAVAILABLE';
  };

  const sendProxyError = (sse, message, init = {}) => {
    sse.send('error', {
      message,
      error: {
        code: init.code || 'UPSTREAM_UNAVAILABLE',
        message,
        ...(init.details === undefined ? {} : { details: init.details }),
        ...(init.retryable === undefined ? {} : { retryable: init.retryable }),
      },
    });
  };

  const appendVersionedApiPath = (baseUrl, path) => {
    const url = new URL(baseUrl);
    // `URL.pathname` setter normalizes an empty string back to "/", so
    // we work in a local string to detect the no-path and no-version
    // cases.
    const trimmed = url.pathname.replace(/\/+$/, '');
    // Auto-inject `/v1` whenever the supplied path doesn't already
    // contain a `/vN` segment. This handles all four preset shapes:
    //   bare host                            → /v1/<route>            (api.openai.com, api.anthropic.com)
    //   ends in /vN                          → no inject              (api.openai.com/v1, /v1)
    //   /vN sub-path                         → no inject              (api.deepinfra.com/v1/openai, openrouter.ai/api/v1)
    //   non-versioned compat sub-path        → /v1/<route>            (api.deepseek.com/anthropic, api.minimaxi.com/anthropic)
    // Previously the check was end-of-path only, which broke the
    // /v1/openai sub-path case. A naive "non-empty path → respect"
    // would break the /anthropic sub-path case. Matching `/vN` as a
    // segment anywhere in the path threads both correctly.
    url.pathname = /\/v\d+(\/|$)/.test(trimmed)
      ? `${trimmed}${path}`
      : `${trimmed}/v1${path}`;
    return url.toString();
  };

  const collectSseFrame = (frame) => {
    const lines = frame.replace(/\r/g, '').split('\n');
    const dataLines = [];
    let event = 'message';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }
    const payload = dataLines.join('\n');
    if (!payload) return { event, payload: '', data: null };
    if (payload === '[DONE]') return { event, payload, data: null };
    try {
      return { event, payload, data: JSON.parse(payload) };
    } catch {
      return { event, payload, data: null };
    }
  };

  const streamUpstreamSse = async (response, onFrame) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (await onFrame(collectSseFrame(frame))) return;
      }
    }

    const tail = buffer.trim();
    if (tail) await onFrame(collectSseFrame(tail));
  };

  const extractOpenAIText = (data) => {
    const choices = data?.choices;
    if (!Array.isArray(choices) || choices.length === 0) return '';
    const first = choices[0];
    if (typeof first?.delta?.content === 'string') return first.delta.content;
    if (typeof first?.text === 'string') return first.text;
    return '';
  };

  const extractStreamErrorMessage = (data) => {
    const err = data?.error;
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (typeof err?.message === 'string') return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return 'unspecified provider error';
    }
  };

  const extractGeminiText = (data) => {
    const candidates = data?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    const parts = candidates[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((part) => part?.text).filter((text) => typeof text === 'string').join('');
  };

  const benignGeminiFinishReasons = new Set(['', 'STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED']);
  const extractGeminiBlockMessage = (data) => {
    const feedback = data?.promptFeedback;
    if (typeof feedback?.blockReason === 'string' && feedback.blockReason) {
      const tail = typeof feedback.blockReasonMessage === 'string' && feedback.blockReasonMessage
        ? ` — ${feedback.blockReasonMessage}`
        : '';
      return `Gemini blocked the prompt (${feedback.blockReason})${tail}.`;
    }
    const candidates = data?.candidates;
    if (!Array.isArray(candidates)) return '';
    for (const candidate of candidates) {
      const reason = candidate?.finishReason;
      if (typeof reason !== 'string' || benignGeminiFinishReasons.has(reason)) continue;
      const tail = typeof candidate?.finishMessage === 'string' && candidate.finishMessage
        ? ` — ${candidate.finishMessage}`
        : '';
      return `Gemini stopped the response (${reason})${tail}.`;
    }
    return '';
  };

  app.post('/api/proxy/anthropic/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } =
      proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'baseUrl, apiKey, and model are required',
      );
    }

    const validated = validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }

    const url = appendVersionedApiPath(baseUrl, '/messages');
    console.log(
      `[proxy:anthropic] ${req.method} ${validated.parsed.hostname} model=${model}`,
    );

    const payload = {
      model,
      max_tokens:
        typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      messages: Array.isArray(messages) ? messages : [],
      stream: true,
    };
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payload.system = systemPrompt;
    }

    const sse = createSseResponse(res);
    sse.send('start', { model });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[proxy:anthropic] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
        );
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      await streamUpstreamSse(response, ({ event, data }) => {
        if (!data) return false;
        if (event === 'error' || data.type === 'error') {
          const message = data.error?.message || data.message || 'Anthropic upstream error';
          sendProxyError(sse, message, { details: data });
          ended = true;
          return true;
        }
        if (event === 'content_block_delta' && typeof data.delta?.text === 'string') {
          sse.send('delta', { delta: data.delta.text });
        }
        if (event === 'message_stop') {
          sse.send('end', {});
          ended = true;
          return true;
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err) {
      console.error(`[proxy:anthropic] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    }
  });

  app.post('/api/proxy/openai/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } =
      proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'baseUrl, apiKey, and model are required',
      );
    }

    const validated = validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }

    const url = appendVersionedApiPath(baseUrl, '/chat/completions');
    console.log(
      `[proxy:openai] ${req.method} ${validated.parsed.hostname} model=${model}`,
    );

    const payloadMessages = Array.isArray(messages) ? [...messages] : [];
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payloadMessages.unshift({ role: 'system', content: systemPrompt });
    }

    const payload = {
      model,
      messages: payloadMessages,
      max_tokens:
        typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      stream: true,
    };

    const sse = createSseResponse(res);
    sse.send('start', { model });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[proxy:openai] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
        );
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      await streamUpstreamSse(response, ({ payload, data }) => {
        if (payload === '[DONE]') {
          sse.send('end', {});
          ended = true;
          return true;
        }
        if (!data) return false;
        const streamError = extractStreamErrorMessage(data);
        if (streamError) {
          sendProxyError(sse, `Provider error: ${streamError}`, { details: data });
          ended = true;
          return true;
        }
        const delta = extractOpenAIText(data);
        if (delta) sse.send('delta', { delta });
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err) {
      console.error(`[proxy:openai] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    }
  });

  app.post('/api/proxy/azure/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens, apiVersion } =
      proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'baseUrl, apiKey, and model are required',
      );
    }

    const validated = validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }

    const version =
      typeof apiVersion === 'string' && apiVersion.trim()
        ? apiVersion.trim()
        : '2024-10-21';
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(model)}/chat/completions`;
    url.searchParams.set('api-version', version);
    console.log(
      `[proxy:azure] ${req.method} ${validated.parsed.hostname} deployment=${model} api-version=${version}`,
    );

    const payloadMessages = Array.isArray(messages) ? [...messages] : [];
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payloadMessages.unshift({ role: 'system', content: systemPrompt });
    }

    const payload = {
      messages: payloadMessages,
      max_tokens:
        typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      stream: true,
    };

    const sse = createSseResponse(res);
    sse.send('start', { model });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[proxy:azure] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
        );
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      await streamUpstreamSse(response, ({ payload: ssePayload, data }) => {
        if (ssePayload === '[DONE]') {
          sse.send('end', {});
          ended = true;
          return true;
        }
        if (!data) return false;
        const streamError = extractStreamErrorMessage(data);
        if (streamError) {
          sendProxyError(sse, `Azure error: ${streamError}`, { details: data });
          ended = true;
          return true;
        }
        const delta = extractOpenAIText(data);
        if (delta) sse.send('delta', { delta });
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err) {
      console.error(`[proxy:azure] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    }
  });

  app.post('/api/proxy/google/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } = proxyBody;
    if (!apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'apiKey and model are required',
      );
    }

    const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com';
    const validated = validateExternalApiBaseUrl(effectiveBaseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }

    const clean = effectiveBaseUrl.replace(/\/+$/, '');
    const url = `${clean}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    console.log(
      `[proxy:google] ${req.method} ${validated.parsed.hostname} model=${model}`,
    );

    const contents = (Array.isArray(messages) ? messages : []).map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));
    const payload = {
      contents,
      generationConfig: {
        maxOutputTokens:
          typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      },
    };
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payload.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const sse = createSseResponse(res);
    sse.send('start', { model });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[proxy:google] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
        );
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      await streamUpstreamSse(response, ({ data }) => {
        if (!data) return false;
        const streamError = extractStreamErrorMessage(data);
        if (streamError) {
          sendProxyError(sse, `Gemini error: ${streamError}`, { details: data });
          ended = true;
          return true;
        }
        const delta = extractGeminiText(data);
        if (delta) sse.send('delta', { delta });
        const blockMessage = extractGeminiBlockMessage(data);
        if (blockMessage) {
          sendProxyError(sse, blockMessage, { details: data });
          ended = true;
          return true;
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err) {
      console.error(`[proxy:google] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    }
  });

  if (fs.existsSync(STATIC_DIR)) {
    const indexHtml = path.join(STATIC_DIR, 'index.html');
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      if (req.path === '/api' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      if (req.path.startsWith('/artifacts/') || req.path.startsWith('/frames/')) {
        next();
        return;
      }
      if (!fs.existsSync(indexHtml)) {
        next();
        return;
      }
      res.sendFile(indexHtml);
    });
  }

  // Wait for `listen` to bind so callers always see the resolved URL —
  // critical when port=0 (ephemeral port) and when the embedding sidecar
  // needs to advertise the port to a parent process before any request
  // can flow. Three callers depend on this contract:
  //   - `apps/daemon/src/cli.ts`            → expects a `url` string
  //   - `apps/daemon/sidecar/server.ts`     → expects `{ url, server }`
  //   - `apps/daemon/tests/version-route.test.ts` → expects `{ url, server }`
  return await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      // `address()` can in theory return `string | AddressInfo | null`. For
      // a TCP listener it's always `AddressInfo` with a `.port` — the guard
      // is belt-and-braces so an unexpected null never silently produces a
      // `http://127.0.0.1:0` URL that callers would then try to fetch.
      const boundPort =
        address && typeof address === 'object' ? address.port : null;
      if (!boundPort) {
        reject(
          new Error(
            `[od] daemon failed to resolve listening port (address=${JSON.stringify(address)})`,
          ),
        );
        return;
      }
      resolvedPort = boundPort;
      // When binding to all interfaces report localhost for local callers;
      // when binding to a specific address (e.g. a Tailscale IP) report that
      // address so remote callers and the sidecar use the correct URL.
      const reportHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      const url = `http://${reportHost}:${resolvedPort}`;
      if (!returnServer) {
        console.log(`[od] daemon listening on ${url}`);
      }
      daemonUrl = url;
      resolve(returnServer ? { url, server } : url);
    });
    // `app.listen` throws synchronously when the port is already in use on
    // some Node versions, but emits an `error` event on others (and for
    // EACCES / EADDRNOTAVAIL even on the same Node). Wire the event so the
    // returned Promise always settles instead of hanging forever.
    server.on('error', reject);
  });
}

function randomId() {
  return randomUUID();
}

function sanitizeSlug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function assembleExample(templateHtml, slidesHtml, title) {
  return templateHtml
    .replace('<!-- SLIDES_HERE -->', slidesHtml)
    .replace(
      /<title>.*?<\/title>/,
      `<title>${title} | Open Design Example</title>`,
    );
}

// Skill example HTML often references shipped images via relative paths
// like `./assets/hero.png`. Those resolve correctly when the file is
// opened from disk, but the web app loads the example into a sandboxed
// iframe via `srcdoc`, where the document URL is `about:srcdoc` and
// relative URLs cannot find the assets. Rewriting them to an absolute
// `/api/skills/<id>/assets/...` URL lets the same HTML render in both
// places — the disk preview keeps working, and the in-app preview now
// fetches assets through the matching route below.
export function rewriteSkillAssetUrls(html: string, skillId: string): string {
  if (typeof html !== 'string' || html.length === 0) return html;
  // Match src/href attributes whose values point at the current skill's
  // assets (`./assets/...` or `assets/...`) or a sibling skill's assets
  // (`../other-skill/assets/...`). Quote style is preserved so we do not
  // disturb the surrounding markup.
  return html.replace(
    /(\s(?:src|href)\s*=\s*)(['"])((?:\.\.\/([^/'"#?]+)\/)?(?:\.\/)?assets\/([^'"#?]+))(\2)/gi,
    (_match, attr, openQuote, _fullPath, siblingSkillId, relPath, closeQuote) => {
      const resolvedSkillId = siblingSkillId || skillId;
      const prefix = `/api/skills/${encodeURIComponent(resolvedSkillId)}/assets/`;
      return `${attr}${openQuote}${prefix}${relPath}${closeQuote}`;
    },
  );
}

export function isLocalSameOrigin(req, port) {
  // Accepts http + https, loopback hosts, OD_WEB_PORT, and the explicit
  // bind host — matching the global origin middleware policy exactly.
  const host = String(req.headers.host || '');
  const origin = req.headers.origin;

  // Build allowed set inline (same logic as buildAllowedOrigins in
  // startServer, but self-contained so the exported helper works
  // without closing over server-scoped variables).
  const ports = [port];
  const webPort = Number(process.env.OD_WEB_PORT);
  if (webPort && webPort !== port) ports.push(webPort);
  const bindHost = process.env.OD_BIND_HOST || '127.0.0.1';
  const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
  const allowedHosts = new Set(
    ports.flatMap((p) => [
      ...loopbackHosts.map((h) => `${h}:${p}`),
      `${bindHost}:${p}`,
    ]),
  );

  // Reject unknown Host first (DNS rebinding / Host header attack)
  if (!allowedHosts.has(host)) return false;

  // Non-browser client with valid Host → allow
  if (origin == null || origin === '') return true;

  const schemes = ['http', 'https'];
  const allowedOrigins = new Set(
    ports.flatMap((p) => [
      ...schemes.flatMap((s) => loopbackHosts.map((h) => `${s}://${h}:${p}`)),
      ...schemes.map((s) => `${s}://${bindHost}:${p}`),
    ]),
  );
  return allowedOrigins.has(String(origin));
}
