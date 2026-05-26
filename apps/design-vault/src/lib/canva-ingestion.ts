import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { load } from "cheerio";

import { generatePptDeckPreview, generateStyleCardPreview } from "./card-preview";
import { buildDesignMd, buildOpenSlideTheme } from "./design-md";
import { withExecutionProtocolPaths, withManifestExecutionPaths, writeExecutionProtocol, writeRouterSkill } from "./execution-protocol";
import { getModelRequestDiagnostics } from "./model-request";
import { requiredPresentationSampleArchetypes } from "./presentation-samples";
import { renderWebPreview } from "./preview";
import {
  capabilitiesPath,
  designAssetsDir,
  designDir,
  designDocPath,
  designMetaPath,
  ensureDataRoots,
  evidencePath,
  getJob,
  isSafeDesignSlug,
  listDesigns,
  manifestPath,
  openSlideThemePath,
  pathExists,
  previewPath,
  profilePath,
  readJson,
  resetDesignDir,
  saveJob,
  skillDir,
  skillPath,
  sourcePath,
  tokensPath,
  vendorDir,
  writeJson,
  writeText,
} from "./storage";
import { getModelConfig, synthesizeDesignProfile } from "./synthesis";
import { normalizeTags, packageTypeTag } from "./tags";
import type {
  AssetRecord,
  DesignEvidence,
  DesignMeta,
  DesignSystemCapability,
  DesignSystemPackageManifest,
  DesignSystemProfile,
  DesignTokens,
  IngestMode,
  IngestionJob,
} from "./types";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 DesignVault/0.1 canva-ingest";
const CANVA_METADATA_USER_AGENTS = [
  { label: "slackbot-preview", value: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
  { label: "twitterbot-preview", value: "Twitterbot/1.0" },
  { label: "facebook-preview", value: "facebookexternalhit/1.1" },
  { label: "browser", value: USER_AGENT },
];
const CANVA_METADATA_TIMEOUT_MS = 15_000;
const MAX_REMOTE_IMAGE_BYTES = 6 * 1024 * 1024;

type CanvaKind = "canva-template" | "canva-editor";

type CanvaSource = {
  input: string;
  url: string;
  host: string;
  kind: CanvaKind;
  id: string;
  slugBase: string;
  inferredTitle: string;
};

type CanvaPageMetadata = {
  fetched: boolean;
  blocked: boolean;
  title?: string;
  description?: string;
  imageCandidates: string[];
  rawTitle?: string;
  fetchStrategy?: string;
};

type StoredCanvaSource = {
  canvaId?: string;
  normalizedUrl?: string;
  metadata?: CanvaPageMetadata;
  assets?: AssetRecord[];
};

function compactText(input: string | undefined, limit = 220) {
  const normalized = input?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function titleCaseFromSlug(input: string) {
  const descriptivePart = input.includes("-") ? input.split("-").slice(1).join("-") : input;
  return descriptivePart
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (["ai", "ui", "ux", "ppt", "b2b", "b2c", "saas"].includes(lower)) return lower.toUpperCase();
      return `${lower[0]?.toUpperCase() ?? ""}${lower.slice(1)}`;
    })
    .join(" ")
    .trim();
}

function skillSafeName(input: string) {
  return (slugify(input) || "canva-design-system").slice(0, 64);
}

export function classifyCanvaUrl(input: string): IngestMode | null {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "canva.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "templates" && parts[1]) return "canva-template";
    if (parts[0] === "design" && parts[1] && parts.includes("edit")) return "canva-editor";
  } catch {}
  return null;
}

function parseCanvaSource(input: string): CanvaSource {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Please provide a Canva template URL or Canva editor URL.");
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const mode = classifyCanvaUrl(input);
  if (!mode || (mode !== "canva-template" && mode !== "canva-editor")) {
    throw new Error("Canva ingest supports canva.com/templates/* and canva.com/design/*/edit URLs.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const templateSegment = parts[1] ?? "";
  const id = mode === "canva-template" ? templateSegment.split("-")[0] || templateSegment : templateSegment;
  const templateTitle = mode === "canva-template" ? titleCaseFromSlug(templateSegment) : "";
  const inferredTitle = templateTitle || `Canva design ${id}`;
  return {
    input,
    url: url.toString(),
    host,
    kind: mode,
    id: id || "canva-design",
    slugBase: slugify(templateTitle || `canva-${id}`) || "canva-design",
    inferredTitle,
  };
}

function normalizeUrl(input: string | undefined, base: string) {
  if (!input) return null;
  const value = input.trim();
  if (!value || value.startsWith("data:")) return null;
  try {
    return new URL(value.startsWith("//") ? `https:${value}` : value, base).toString();
  } catch {
    return null;
  }
}

function srcsetUrls(input: string | undefined, base: string) {
  if (!input) return [];
  return input
    .split(",")
    .map((part) => normalizeUrl(part.trim().split(/\s+/)[0], base))
    .filter((value): value is string => Boolean(value));
}

async function fetchCanvaMetadata(source: CanvaSource): Promise<CanvaPageMetadata> {
  if (source.kind === "canva-editor") {
    return {
      fetched: false,
      blocked: true,
      title: source.inferredTitle,
      description: "Canva editor links require an authenticated browser session or an exported PDF/PPTX to capture the actual deck.",
      imageCandidates: [],
    };
  }

  const attempts: CanvaPageMetadata[] = [];
  for (const agent of CANVA_METADATA_USER_AGENTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CANVA_METADATA_TIMEOUT_MS);
    const response = await fetch(source.url, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": agent.value,
      },
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeout);
    if (!response?.ok) continue;

    const html = await response.text().catch(() => "");
    const parsed = parseCanvaMetadataHtml(source, html, agent.label);
    attempts.push(parsed);
    if (!parsed.blocked && parsed.imageCandidates.length > 0) return parsed;
  }

  return attempts.sort((a, b) => b.imageCandidates.length - a.imageCandidates.length || Number(Boolean(b.description)) - Number(Boolean(a.description)))[0] ?? {
    fetched: false,
    blocked: true,
    title: source.inferredTitle,
    imageCandidates: [],
  };
}

async function findCachedCanvaSource(source: CanvaSource) {
  const designs = await listDesigns();
  for (const design of designs) {
    if (design.sourceMode !== "canva-template" && design.sourceMode !== "canva-editor") continue;
    if (design.sourceUrl !== source.url && design.requestedSourceUrl !== source.url && !design.sourceUrl.includes(source.id)) continue;
    const stored = await readJson<StoredCanvaSource>(sourcePath(design.slug));
    if (!stored) continue;
    if (stored.canvaId && stored.canvaId !== source.id) continue;
    const hasMetadata = (stored.metadata?.imageCandidates.length ?? 0) > 0;
    const hasAssets = (stored.assets ?? []).some((asset) => (asset.kind === "image" || asset.kind === "svg") && !asset.path.includes("style-source.svg"));
    if (hasMetadata || hasAssets) return { slug: design.slug, source: stored };
  }
  return null;
}

async function metadataWithCache(source: CanvaSource) {
  const metadata = await fetchCanvaMetadata(source);
  if (!metadata.blocked && metadata.imageCandidates.length > 0) return metadata;
  const cached = await findCachedCanvaSource(source);
  if (!cached?.source.metadata?.imageCandidates.length) return metadata;
  return {
    ...cached.source.metadata,
    fetched: true,
    blocked: false,
    fetchStrategy: `cache:${cached.slug}`,
  };
}

function parseCanvaMetadataHtml(source: CanvaSource, html: string, fetchStrategy: string): CanvaPageMetadata {
  const $ = load(html);
  const rawTitle = $("title").first().text().trim();
  const title =
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='twitter:title']").attr("content") ||
    (rawTitle && rawTitle.toLowerCase() !== "canva" ? rawTitle : undefined) ||
    source.inferredTitle;
  const description =
    $("meta[property='og:description']").attr("content") ||
    $("meta[name='description']").attr("content") ||
    $("meta[name='twitter:description']").attr("content") ||
    undefined;
  const candidates: string[] = [];
  const push = (value: string | null) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  push(normalizeUrl($("meta[property='og:image']").attr("content"), source.url));
  push(normalizeUrl($("meta[name='twitter:image']").attr("content"), source.url));
  $("link[as='image'], link[rel='preload'], link[rel='image_src']").each((_, element) => {
    push(normalizeUrl($(element).attr("href"), source.url));
  });
  $("img").each((_, element) => {
    push(normalizeUrl($(element).attr("src"), source.url));
    for (const item of srcsetUrls($(element).attr("srcset"), source.url)) push(item);
  });

  const blocked = candidates.length === 0 && !description && (!title || rawTitle.toLowerCase() === "canva" || title === source.inferredTitle);
  return {
    fetched: true,
    blocked,
    title: compactText(title, 120),
    description: compactText(description, 360),
    imageCandidates: candidates.slice(0, 12),
    rawTitle,
    fetchStrategy,
  };
}

function imageExtFromMime(contentType: string | null) {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/svg+xml") return ".svg";
  return null;
}

function imageExtFromUrl(url: string) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext) ? (ext === ".jpeg" ? ".jpg" : ext) : null;
  } catch {
    return null;
  }
}

function xmlEscape(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function inferPalette(corpus: string): DesignTokens["colors"] {
  const lower = corpus.toLowerCase();
  const namedColors = [
    { pattern: /black/, value: "#111111" },
    { pattern: /white/, value: "#ffffff" },
    { pattern: /red/, value: "#e92221" },
    { pattern: /yellow|gold/, value: "#ffe58d" },
    { pattern: /blue/, value: "#2563eb" },
    { pattern: /green/, value: "#15803d" },
    { pattern: /purple|violet/, value: "#7c3aed" },
    { pattern: /gray|grey/, value: "#7c7c7c" },
    { pattern: /brown/, value: "#6b4f3a" },
    { pattern: /beige|cream/, value: "#f3eadf" },
  ].filter((item) => item.pattern.test(lower));
  const primary = namedColors[0]?.value ?? "#111827";
  const secondary = namedColors.find((item) => item.value !== primary)?.value ?? "#d6b36a";
  const surface = namedColors.find((item) => item.value === "#ffffff" || item.value === "#ffe58d" || item.value === "#f3eadf")?.value ?? "#f7f3ea";
  const text = surface === "#111111" ? "#ffffff" : "#111827";
  return { primary, secondary, success: "#16a34a", warning: "#f59e0b", danger: "#dc2626", surface, text, neutral: "#e8e2d5" };
}

function buildTokens(title: string, description: string | undefined): DesignTokens {
  const colors = inferPalette(`${title} ${description ?? ""}`);
  return {
    colors,
    typography: {
      scale: ["12", "14", "16", "20", "28", "40", "56"],
      families: {
        primary: "Canva Sans",
        display: "Canva Sans",
        mono: "IBM Plex Mono",
      },
      weights: ["400", "500", "600", "700"],
    },
    spacing: {
      baseline: "source-derived rhythm",
      layout: "Preserve the source thumbnail's observed density, margin behavior, alignment, and image/text proportion.",
    },
    motion: {
      transition: "200ms",
      easing: "ease-out",
      notes: ["Keep generated motion subtle; Canva template imports are visual references rather than animation systems."],
    },
  };
}

function syntheticCanvaSvg(title: string, source: CanvaSource, tokens: DesignTokens) {
  const { colors } = tokens;
  const modeLabel = source.kind === "canva-template" ? "TEMPLATE" : "EDITOR";
  const words = title.split(/\s+/).filter(Boolean);
  const headline = words.slice(0, 5).join(" ") || "Canva Design";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750" viewBox="0 0 1200 750">
  <rect width="1200" height="750" fill="${colors.surface}"/>
  <rect x="48" y="48" width="1104" height="654" rx="28" fill="${colors.text}" opacity=".06"/>
  <rect x="84" y="84" width="1032" height="582" rx="24" fill="${colors.surface}" stroke="${colors.text}" stroke-opacity=".16" stroke-width="2"/>
  <rect x="84" y="84" width="420" height="582" rx="24" fill="${colors.text}"/>
  <circle cx="968" cy="190" r="96" fill="${colors.primary}" opacity=".88"/>
  <circle cx="1036" cy="268" r="58" fill="${colors.secondary}" opacity=".62"/>
  <text x="128" y="146" fill="${colors.surface}" font-size="26" font-family="Arial, sans-serif" font-weight="700" letter-spacing="8">${xmlEscape(modeLabel)}</text>
  <text x="128" y="260" fill="${colors.surface}" font-size="78" font-family="Georgia, serif" font-weight="700">${xmlEscape(headline)}</text>
  <text x="128" y="328" fill="${colors.surface}" opacity=".72" font-size="28" font-family="Arial, sans-serif">${xmlEscape(source.host)}</text>
  <rect x="552" y="168" width="270" height="168" rx="18" fill="${colors.text}" opacity=".9"/>
  <rect x="852" y="168" width="192" height="168" rx="18" fill="${colors.secondary}" opacity=".55"/>
  <rect x="552" y="374" width="492" height="42" rx="21" fill="${colors.primary}"/>
  <rect x="552" y="452" width="236" height="28" rx="14" fill="${colors.text}" opacity=".18"/>
  <rect x="552" y="504" width="356" height="28" rx="14" fill="${colors.text}" opacity=".12"/>
  <rect x="552" y="586" width="136" height="34" rx="17" fill="${colors.text}"/>
  <rect x="720" y="586" width="136" height="34" rx="17" fill="${colors.secondary}"/>
</svg>`;
}

async function writeSyntheticAsset(slug: string, source: CanvaSource, title: string, tokens: DesignTokens): Promise<AssetRecord> {
  const dir = path.join(designAssetsDir(slug), "canva-previews");
  await mkdir(dir, { recursive: true });
  const fileName = "style-source.svg";
  await writeFile(path.join(dir, fileName), syntheticCanvaSvg(title, source, tokens), "utf8");
  return {
    name: "Fallback Canva style source",
    kind: "svg",
    path: `assets/canva-previews/${fileName}`,
    sourceUrl: source.url,
  };
}

async function downloadImageAsset(slug: string, index: number, url: string): Promise<AssetRecord | null> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } }).catch(() => null);
  if (!response?.ok) return null;
  const size = Number(response.headers.get("content-length") ?? "0");
  if (size > MAX_REMOTE_IMAGE_BYTES) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.byteLength || buffer.byteLength > MAX_REMOTE_IMAGE_BYTES) return null;
  const ext = imageExtFromMime(response.headers.get("content-type")) ?? imageExtFromUrl(url);
  if (!ext) return null;
  const dir = path.join(designAssetsDir(slug), "canva-previews");
  await mkdir(dir, { recursive: true });
  const fileName = `preview-${String(index).padStart(2, "0")}${ext}`;
  await writeFile(path.join(dir, fileName), buffer);
  return {
    name: `Canva template preview ${index}`,
    kind: ext === ".svg" ? "svg" : "image",
    path: `assets/canva-previews/${fileName}`,
    sourceUrl: url,
  };
}

async function collectCanvaAssets(slug: string, source: CanvaSource, metadata: CanvaPageMetadata, title: string, tokens: DesignTokens) {
  const assets: AssetRecord[] = [];
  for (const candidate of metadata.imageCandidates) {
    if (assets.length >= 6) break;
    const asset = await downloadImageAsset(slug, assets.length + 1, candidate);
    if (asset) assets.push(asset);
  }
  if (!assets.length) {
    const cached = await findCachedCanvaSource(source);
    const reusableAssets = (cached?.source.assets ?? []).filter((asset) => (asset.kind === "image" || asset.kind === "svg") && !asset.path.includes("style-source.svg")).slice(0, 6);
    for (const asset of reusableAssets) {
      const sourceFile = path.join(designDir(cached!.slug), asset.path);
      const targetFile = path.join(designDir(slug), asset.path);
      if (!(await pathExists(sourceFile))) continue;
      await mkdir(path.dirname(targetFile), { recursive: true });
      await cp(sourceFile, targetFile, { force: true });
      assets.push({ ...asset, name: `Cached ${asset.name}` });
    }
  }
  if (!assets.length) assets.push(await writeSyntheticAsset(slug, source, title, tokens));
  return assets;
}

function hasLocalizedSourceVisuals(assets: AssetRecord[]) {
  return assets.some((asset) => (asset.kind === "image" || asset.kind === "svg") && !asset.path.includes("style-source.svg") && !/fallback|generated/i.test(asset.name));
}

function buildCapabilities(source: CanvaSource, metadata: CanvaPageMetadata): DesignSystemCapability[] {
  const capabilities: DesignSystemCapability[] = [
    {
      id: source.kind === "canva-template" ? "canva-template-preview" : "authenticated-editor-capture",
      label: source.kind === "canva-template" ? "Canva template preview" : "Authenticated editor capture",
      category: "workflow",
      description:
        source.kind === "canva-template"
          ? "从 Canva 公开模板页读取官方预览图、标题和描述，并编译成可复用演示风格。"
          : "从 Canva 登录态编辑器链接建立导入任务，并优先引导导出 PDF/PPTX 或逐页截图。",
      usage:
        source.kind === "canva-template"
          ? "需要按 Canva 模板风格生成封面、作品集、演示稿或卡片样张时使用。"
          : "用户给出自己的 Canva 编辑链接，需要抽取当前设计而不是公开模板时使用。",
      evidence: [source.url, metadata.blocked ? "Public HTTP metadata was blocked or incomplete; use browser/export capture for higher fidelity." : "Canva metadata request returned usable page signals."],
      sourcePaths: [],
    },
    {
      id: "presentation-template",
      label: "Presentation template",
      category: "layout",
      description: "将 Canva 模板抽象为封面、章节、图文页、作品集页和视觉叙事页。",
      usage: "生成与源素材同类的 deck、横向网页演示稿或视觉样张时使用。",
      evidence: [metadata.title ?? source.inferredTitle],
      sourcePaths: [],
    },
    {
      id: "style-card-generation",
      label: "Style card generation",
      category: "adapter",
      description: "用抽象后的 Canva 风格上下文生成固定比例 HTML 样张卡片。",
      usage: "Design Vault 资料库卡片和预览 tab 应优先渲染这个视觉样张，而不是展示风格文案。",
      evidence: ["STYLE_CARD.html is generated during ingest."],
      sourcePaths: ["STYLE_CARD.html"],
    },
    {
      id: "pdf-pptx-export-reference",
      label: "PDF/PPTX export reference",
      category: "workflow",
      description: "当需要更高保真结构时，让用户从 Canva 导出 PDF/PPTX 后再解析。",
      usage: "需要实际页数、用户修改后的内容、文本框和页面结构时使用导出文件作为主证据。",
      evidence: ["Canva editor source requires authenticated export for stable structure."],
      sourcePaths: [],
    },
  ];
  if (source.kind === "canva-editor") {
    capabilities.push({
      id: "page-screenshot-capture",
      label: "Page screenshot capture",
      category: "asset",
      description: "通过登录态浏览器逐页截图，保存为 Design Vault 本地页面图。",
      usage: "无法导出时，用逐页截图作为视觉证据和风格卡片的基础。",
      evidence: ["Canva editor links expose current user design only in authenticated browser context."],
      sourcePaths: ["assets/canva-pages/page-001.png"],
    });
  }
  return capabilities;
}

function buildEvidence(source: CanvaSource, metadata: CanvaPageMetadata, title: string, capabilities: DesignSystemCapability[], tokens: DesignTokens, assets: AssetRecord[]): DesignEvidence {
  return {
    title,
    sourceUrl: source.url,
    sourceHost: source.host,
    sourceMode: source.kind,
    requestedSourceUrl: source.url,
    sourceChain: [
      {
        role: "requested",
        url: source.url,
        host: source.host,
        title,
        note: source.kind === "canva-template" ? "Canva public template URL routed to template-image ingest." : "Canva authenticated editor URL routed to editor ingest.",
      },
    ],
    description:
      metadata.description ??
      (source.kind === "canva-template"
        ? `${title} imported from a Canva template URL as a presentation design system.`
        : `${title} imported from a Canva editor URL. Export PDF/PPTX or authenticated screenshots are recommended for full fidelity.`),
    headings: [title, ...capabilities.slice(0, 3).map((capability) => capability.label)],
    buttonLabels: source.kind === "canva-editor" ? ["Export PDF", "Export PPTX", "Capture pages"] : ["Use template", "Preview style"],
    linkLabels: ["Canva source"],
    colorCandidates: Object.values(tokens.colors).map((value, index) => ({ value, count: 10 - index })),
    fontCandidates: Object.values(tokens.typography.families),
    domSignals: { headingCount: 1, sectionCount: 4, buttonCount: 2, linkCount: 1, imageCount: assets.length, formCount: 0, navCount: 0, cardLikeCount: 1 },
    interactionSignals: { hasHoverStyles: false, hasAnimations: false, hasTransitions: true, hasStickyElements: false, hasScrollSnap: false, hasForms: false },
    assetSummary: {
      total: assets.length,
      icons: 0,
      images: assets.filter((asset) => asset.kind === "image").length,
      logos: 0,
      svgs: assets.filter((asset) => asset.kind === "svg").length,
      videos: assets.filter((asset) => asset.kind === "video").length,
    },
    sections: capabilities.map((capability, index) => ({
      id: capability.id,
      order: index + 1,
      tag: "section",
      selector: capability.id,
      role: index === 0 ? "hero" : "content",
      label: capability.label,
      headings: [capability.label],
      textSample: capability.description,
      ctas: [],
      links: [],
      assetRefs: assets.slice(0, 2).map((asset) => asset.path),
      componentHints: [capability.category],
      interactionHints: [capability.usage],
    })),
    roleEvidence: [
      { role: "background", value: tokens.colors.surface, evidence: ["Candidate surface color derived from source metadata and localized preview availability; verify against source image pixels."], confidence: "medium" },
      { role: "text", value: tokens.colors.text, evidence: ["Candidate text color derived for contrast with the source surface role; verify visually."], confidence: "medium" },
      { role: "accent", value: tokens.colors.primary, evidence: ["Candidate accent color derived from explicit source metadata color words when present; verify against localized preview assets."], confidence: "medium" },
    ],
    notes: [
      metadata.blocked
        ? "Canva public HTML did not expose durable template content to server-side fetch; Design Vault generated a local style source and recommends browser/export capture for higher fidelity."
        : "Canva template metadata exposed preview candidates that were localized into assets.",
      source.kind === "canva-editor" ? "Do not treat Canva editor DOM/JS as the design source; capture PDF/PPTX/screenshots instead." : "Template-page images are preview evidence, not complete editable slide structure.",
    ],
  };
}

function buildProfile(source: CanvaSource, metadata: CanvaPageMetadata, title: string, capabilities: DesignSystemCapability[], tokens: DesignTokens, assets: AssetRecord[]): DesignSystemProfile {
  const templateMode = source.kind === "canva-template";
  const confidence = templateMode && !metadata.blocked ? "medium" : "low";
  const visualThesis = templateMode
    ? `${title} should be used as a source-derived presentation design system: preserve the source's recognisable visual relationships before generating any derivative.`
    : `${title} is an authenticated Canva editor source; use exported PDF/PPTX or page screenshots as the visual source of truth before generating new work.`;

  return {
    schemaVersion: "2.0",
    systemName: title,
    archetype: templateMode ? "canva-template-presentation" : "canva-authenticated-editor",
    confidence,
    visualThesis,
    summary:
      metadata.description ??
      (templateMode
        ? `${title} imported from a Canva template page and compiled into a presentation-system wrapper skill.`
        : `${title} imported from a Canva editor link with capture/export instructions for higher-fidelity extraction.`),
    methodology: {
      sourceOfTruth: templateMode ? ["Localized source preview images", "Source metadata", "Generated STYLE_CARD.html"] : ["Authenticated source editor", "User-confirmed PDF/PPTX export", "Page screenshots"],
      abstractionSteps: [
        "Localize source visuals before writing style rules.",
        "Describe color as roles and relationships: dominant field, text role, accent role, contrast rhythm.",
        "Describe typography by hierarchy and behavior: display role, body role, metadata role, scale contrast.",
        "Describe composition by visible structure: image/text ratio, focal area, alignment, margins, recurring chrome.",
        "Generate derivative previews from those roles, then compare the thumbnail against source recognition.",
      ],
      fidelityChecks: ["STYLE_CARD must be visual, not a prose report.", "Derivative previews must preserve the source's recognisable color relationship, type hierarchy, image treatment, and layout rhythm.", "When exact user content matters, prefer PDF/PPTX export over editor DOM code."],
    },
    visualDna: {
      colorAtmosphere: "Preserve the source image's dominant field, text contrast, accent placement, and alternation rhythm instead of substituting a default palette.",
      typographySignal: "Preserve the source hierarchy: display type scale, supporting text density, metadata treatment, weight contrast, and case/spacing behavior.",
      layoutGrammar: "Translate the source's visible structure: focal area, type field, alignment, margins, and recurring chrome.",
      componentLanguage: capabilities.map((capability) => capability.label).join(", "),
      motionCharacter: "Motion should support the original presentation rhythm and avoid changing the perceived design language.",
      mustPreserve: ["Source-recognisable color relationship", "Source-recognisable typography hierarchy", "Source image treatment and crop logic", "Source layout rhythm and metadata placement"],
    },
    previewStrategy: {
      renderer: "custom",
      rationale: "Canva imports should generate derivative specimens from the abstracted visual method, not quote prose or clone editor UI.",
      layoutDirectives: ["Use a fixed-ratio style-card stage", "Start from localized source images as visual evidence", "Recompose source roles into a new but recognisable web/PPT specimen"],
      avoidDirectives: ["Do not display extraction prose on the card", "Do not clone the Canva editor UI", "Do not depend on expiring Canva signed image URLs"],
    },
    colorRoles: {
      brandPrimary: tokens.colors.primary,
      brandSecondary: tokens.colors.secondary,
      background: tokens.colors.surface,
      text: tokens.colors.text,
      notes: ["Palette is a candidate role map from explicit source metadata and localized preview availability; source images remain the visual truth."],
    },
    typographyRoles: {
      display: tokens.typography.families.display,
      body: tokens.typography.families.primary,
      mono: tokens.typography.families.mono,
      rationale: ["Use display type for slide-level ideas and small sans/mono labels for metadata."],
    },
    spacingSystem: {
      base: tokens.spacing.baseline,
      density: "Match the source density: preserve whether the template feels sparse, packed, editorial, graphic, modular, or image-led.",
      rhythmNotes: ["Derive rhythm from source thumbnails: repeat the observed alternation between image, type, color field, evidence, and metadata areas without assuming a default pattern."],
    },
    compositionSignatures: ["source-recognition opening", "source-derived layout pattern", "localized asset specimen", "fixed-ratio style card", "web/PPT derivative preview"],
    componentSignatures: capabilities.slice(0, 6).map((capability) => ({
      name: capability.label,
      role: capability.category,
      traits: [capability.description],
      states: ["static", "preview"],
    })),
    componentMotionRecipes: [
      {
        id: "source-compatible-transition",
        component: "Slide frame and focal content",
        role: "presentation rhythm transfer",
        trigger: "slide-enter",
        statePair: "initial source composition -> settled slide frame",
        properties: ["opacity", "transform", "crop/mask"],
        timing: { duration: tokens.motion.transition, easing: tokens.motion.easing },
        choreography: ["Reveal focal image or type first.", "Bring metadata/chrome in after the primary hierarchy settles."],
        cssHint: "Use source-compatible transition only; Canva imports are static visual references.",
        pptAdapter: ["Use as entrance choreography for generated PPT previews.", "Preserve the original template rhythm rather than adding decorative effects."],
        evidence: ["Canva template previews are visual rhythm evidence, not runtime interaction evidence."],
        confidence: "medium",
      },
      {
        id: "density-aware-reveal",
        component: "Repeated slide modules",
        role: "module reveal",
        trigger: "sequence / slide-enter",
        statePair: "hidden module -> visible module",
        properties: ["opacity", "translation", "stagger"],
        timing: { duration: tokens.motion.transition, easing: tokens.motion.easing, stagger: "60-120ms" },
        choreography: ["Reveal dense modules with small stagger.", "Keep sparse layouts calm with one-step reveal."],
        cssHint: "Match reveal density to source thumbnail density.",
        pptAdapter: ["Use stagger only when the source layout has repeated modules.", "Avoid kinetic motion on static editorial pages."],
        evidence: ["Localized Canva preview density and presentationStyle motionRecipes."],
        confidence: "medium",
      },
    ],
    interactionModel: {
      character: "Source import produces static visual references; runtime interaction belongs to the consuming agent/app.",
      states: ["preview", "export-required", "localized-asset"],
      motionNotes: tokens.motion.notes,
    },
    voiceAndBrand: {
      tone: ["source-grounded", "fidelity-first", "asset-led"],
      copyNotes: ["Use only enough visible copy to reveal the source hierarchy; avoid turning analysis text into the visual artifact."],
    },
    accessibilityAndRisks: [
      "Canva template preview images may not represent all pages in a deck.",
      "Canva editor links require authenticated capture; server-side HTML code is not the design source.",
      "License and commercial rights remain unknown unless the user verifies Canva template terms.",
    ],
    antiPatterns: [
      "Do not clone Canva's editor shell as the visual system.",
      "Do not use expired remote preview URLs as durable assets.",
      "Do not turn design analysis prose into card content.",
      "Do not assume a template page exposes complete slide structure.",
    ],
    evidenceSummary: [
      `Source kind: ${source.kind}`,
      `Title: ${title}`,
      `Localized preview assets: ${assets.length}`,
      metadata.blocked ? "Server-side fetch was blocked/incomplete." : "Metadata fetch returned preview candidates.",
    ],
    openSlideGuidance: {
      direction: "Use this as a source-derived presentation style system: every generated page must remain recognisable as a derivative of the localized source visuals.",
      coverApproach: "Identify the source frame's focal hierarchy first, then preserve its image/text relationship and metadata placement.",
      layoutApproach: ["Keep the source ratio and dominant composition logic", "Match source copy density", "Follow the source's observed rhythm", "Preserve extracted color roles and contrast relationships"],
      motionApproach: ["Use transitions that support the source rhythm", "Avoid decorative motion that changes the design language"],
    },
    presentationStyle: {
      narrativeArc: ["source-recognition opening", "context derivative", "evidence derivative", "structure derivative", "closing derivative"],
      themeRhythm: {
        paletteRule: "Use extracted color roles as relationships, not as decorative defaults: dominant field, text contrast, accent, and supporting neutral.",
        lightDarkPattern: ["mirror source contrast alternation", "insert divider or emphasis pages only when the source rhythm supports them"],
        emphasisCadence: ["preserve source density changes", "preserve source focal hierarchy", "preserve metadata/chrome cadence"],
      },
      slideArchetypes: [
        ...requiredPresentationSampleArchetypes(),
        { name: "Source-recognition derivative", use: "Open with immediate source recognition.", construction: ["dominant source role", "primary hierarchy", "metadata placement", "same contrast relationship"] },
        { name: "Evidence/example derivative", use: "Show content while preserving source composition grammar.", construction: ["image or proof field", "text hierarchy", "source-like margin system", "recurring chrome"] },
        { name: "Rhythm reset derivative", use: "Create a divider or shift that follows source alternation.", construction: ["dominant color or image field", "single focal message", "metadata/index treatment"] },
      ],
      typographyHierarchy: ["source display role", "source supporting text role", "source metadata role"],
      imageRules: ["Use localized source images as evidence", "Match the source crop behavior and image/text proportion", "Do not replace source image treatment with generic thumbnails"],
      motionRecipes: ["source-compatible transition", "density-aware reveal", "apply componentMotionRecipes when generating animated previews"],
      chromeAndMetadata: ["preserve the source's recurring labels, index, footer, or page chrome when present"],
      qualityChecks: ["Source-recognition thumbnail check", "No clipped text", "No prose report in STYLE_CARD", "No Canva editor UI chrome", "No default palette or layout substitution"],
    },
    synthesis: {
      mode: "heuristic",
      status: "heuristic-only",
      reason: "Canva import adapter generated from source URL, metadata, and localized preview assets.",
      promptVersion: "canva-design-system-ingest-v2-presentation-samples",
      evidenceStats: {
        headings: 1,
        buttons: 2,
        links: 1,
        colors: Object.values(tokens.colors).length,
        fonts: Object.values(tokens.typography.families).length,
        sections: capabilities.length,
        behaviorSignals: 0,
        responsiveSignals: 0,
      },
    },
  };
}

function mergeCanvaModelProfile(modelProfile: DesignSystemProfile, canvaProfile: DesignSystemProfile): DesignSystemProfile {
  const modelMethodology = modelProfile.methodology;
  const canvaMethodology = canvaProfile.methodology;
  const modelDna = modelProfile.visualDna;
  const canvaDna = canvaProfile.visualDna;
  const modelPreview = modelProfile.previewStrategy;
  const canvaPreview = canvaProfile.previewStrategy;

  return {
    ...modelProfile,
    ...canvaProfile,
    systemName: canvaProfile.systemName || modelProfile.systemName,
    methodology: canvaMethodology ?? modelMethodology,
    visualDna: modelDna || canvaDna
      ? {
          colorAtmosphere: canvaDna?.colorAtmosphere ?? modelDna?.colorAtmosphere ?? "",
          typographySignal: canvaDna?.typographySignal ?? modelDna?.typographySignal ?? "",
          layoutGrammar: canvaDna?.layoutGrammar ?? modelDna?.layoutGrammar ?? "",
          componentLanguage: canvaDna?.componentLanguage ?? modelDna?.componentLanguage ?? "",
          motionCharacter: canvaDna?.motionCharacter ?? modelDna?.motionCharacter ?? "",
          mustPreserve: uniqueStrings(canvaDna?.mustPreserve?.length ? canvaDna.mustPreserve : (modelDna?.mustPreserve ?? [])),
        }
      : undefined,
    previewStrategy: modelPreview || canvaPreview
      ? {
          renderer: canvaPreview?.renderer ?? modelPreview?.renderer ?? "custom",
          rationale: canvaPreview?.rationale ?? modelPreview?.rationale ?? "",
          layoutDirectives: uniqueStrings([...(canvaPreview?.layoutDirectives ?? []), ...(canvaPreview ? [] : (modelPreview?.layoutDirectives ?? []))]),
          avoidDirectives: uniqueStrings([...(canvaPreview?.avoidDirectives ?? []), ...(canvaPreview ? [] : (modelPreview?.avoidDirectives ?? []))]),
        }
      : undefined,
    componentSignatures: [...canvaProfile.componentSignatures, ...modelProfile.componentSignatures].slice(0, 10),
    accessibilityAndRisks: uniqueStrings([...canvaProfile.accessibilityAndRisks, ...modelProfile.accessibilityAndRisks]),
    antiPatterns: uniqueStrings([...canvaProfile.antiPatterns, ...modelProfile.antiPatterns]),
    evidenceSummary: uniqueStrings([...canvaProfile.evidenceSummary, ...modelProfile.evidenceSummary]),
    openSlideGuidance: {
      direction: canvaProfile.openSlideGuidance.direction || modelProfile.openSlideGuidance.direction,
      coverApproach: canvaProfile.openSlideGuidance.coverApproach || modelProfile.openSlideGuidance.coverApproach,
      layoutApproach: uniqueStrings(canvaProfile.openSlideGuidance.layoutApproach.length ? canvaProfile.openSlideGuidance.layoutApproach : modelProfile.openSlideGuidance.layoutApproach),
      motionApproach: uniqueStrings(canvaProfile.openSlideGuidance.motionApproach.length ? canvaProfile.openSlideGuidance.motionApproach : modelProfile.openSlideGuidance.motionApproach),
    },
    presentationStyle: canvaProfile.presentationStyle ?? modelProfile.presentationStyle,
    synthesis: modelProfile.synthesis,
  };
}

async function synthesizeCanvaProfile(evidence: DesignEvidence, tokens: DesignTokens, heuristicProfile: DesignSystemProfile) {
  const startedAt = Date.now();
  try {
    return {
      profile: await synthesizeDesignProfile(evidence, tokens),
      error: null as string | null,
    };
  } catch (error) {
    if (getModelConfig()?.requireModel) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return {
      profile: {
        ...heuristicProfile,
        evidenceSummary: uniqueStrings([
          ...heuristicProfile.evidenceSummary,
          `Model synthesis failed; Canva import used localized template images and heuristic source rules instead. ${reason}`,
        ]),
        synthesis: {
          ...heuristicProfile.synthesis,
          status: "model-failed" as const,
          reason,
          durationMs: Date.now() - startedAt,
          required: false,
        },
      },
      error: reason,
    };
  }
}

async function writeSkillPackage(slug: string, manifest: DesignSystemPackageManifest, capabilities: DesignSystemCapability[], tokens: DesignTokens) {
  const referencesDir = path.join(skillDir(slug), "references");
  await mkdir(referencesDir, { recursive: true });
  await writeText(
    path.join(referencesDir, "catalog.md"),
    `# ${manifest.name} Catalog

Source: ${manifest.source.normalizedUrl ?? manifest.source.input}
Type: ${manifest.packageType}
Confidence: ${manifest.confidence}

## Best For

${manifest.bestFor.map((item) => `- ${item}`).join("\n")}

## Not For

${manifest.notFor.map((item) => `- ${item}`).join("\n")}
`,
  );
  await writeText(
    path.join(referencesDir, "components.md"),
    `# Capabilities

${capabilities.map((item) => `## ${item.label}\n\n- id: \`${item.id}\`\n- category: ${item.category}\n- usage: ${item.usage}\n- evidence: ${item.evidence.join("; ")}`).join("\n\n")}
`,
  );
  await writeText(
    path.join(referencesDir, "tokens.md"),
    `# Tokens

\`\`\`json
${JSON.stringify(tokens, null, 2)}
\`\`\`
`,
  );
  await writeText(
    path.join(referencesDir, "capture.md"),
    `# Canva Capture Notes

- Template URLs are best for preview images, source metadata, and visual style abstraction.
- Editor URLs are best for a user's current design, but require authenticated browser screenshots or user-confirmed PDF/PPTX export.
- Do not use Canva editor DOM or JavaScript bundles as the design source.
- Treat remote Canva image URLs as temporary until they are localized into Design Vault assets.
`,
  );
  await writeText(
    path.join(referencesDir, "checklist.md"),
    `# Checklist

- Read PRODUCT.md, execution/DESIGN.md, STYLE_CARD.html, anti-patterns.json, and quality-gates.json.
- Match the STYLE_CARD and localized source images for visual density, composition rhythm, color relationships, and typography hierarchy.
- If exact user content matters, request or use a PDF/PPTX export before generating.
- Do not output a prose report as a visual card.
`,
  );
  await writeText(
    skillPath(slug),
    `---
name: ${manifest.skill.name}
description: Use this Design Vault source-derived presentation design system when building decks, style cards, or visual templates that match ${manifest.name}. Triggers include Canva template, Canva editor, presentation-system, source-derived visual system, and ${manifest.capabilities.slice(0, 6).join(", ")}.
---

# ${manifest.name}

Use this wrapper skill as the local entrypoint for a source-derived Design Vault system.

## Required Reading

1. Read \`${manifest.local.manifestPath}\` for source kind, confidence, license, and risk notes.
2. Read \`${manifest.local.productPath ?? "PRODUCT.md"}\`, \`${manifest.local.designSpecPath ?? "execution/DESIGN.md"}\`, and \`${manifest.local.styleCardPath ?? "STYLE_CARD.html"}\`.
3. Read \`${manifest.local.capabilitiesPath}\` and choose the closest capability before generating.
4. Use \`${path.join(referencesDir, "capture.md")}\` when deciding whether template images, screenshots, PDF, or PPTX should be the source of truth.

## Usage Rule

Build with the localized source visuals and abstracted visual grammar, not Canva's editor UI. STYLE_CARD.html is the visual target, and source images are the fidelity evidence. If the task depends on the user's actual edited content, prefer exported PDF/PPTX or authenticated page screenshots before creating final output.
`,
  );
}

function createManifest(source: CanvaSource, slug: string, title: string, metadata: CanvaPageMetadata, capabilities: DesignSystemCapability[], createdAt: string): DesignSystemPackageManifest {
  const skillName = skillSafeName(`canva-${title}`);
  const entrypoint = skillPath(slug);
  const packageType = "presentation-system" as const;
  return withManifestExecutionPaths({
    schemaVersion: "1.0",
    id: slug,
    name: title,
    packageType,
    secondaryTypes: ["visual-style-system"],
    confidence: source.kind === "canva-template" && !metadata.blocked ? "medium" : "low",
    summary:
      metadata.description ??
      (source.kind === "canva-template"
        ? `${title} imported from a Canva template URL as a reusable source-derived presentation design system.`
        : `${title} imported from a Canva editor URL; use export/screenshot capture for high-fidelity extraction.`),
    bestFor: ["Source-recognisable presentation decks", "Template-derived style cards", "Preview-image driven visual systems", "Open-slide / HTML deck generation"],
    notFor: ["Production component libraries", "Cloning Canva's editor UI", "Exact user-edited content without PDF/PPTX/screenshots"],
    capabilities: capabilities.map((capability) => capability.id),
    source: {
      input: source.input,
      kind: source.kind,
      normalizedUrl: source.url,
      host: source.host,
      license: "unknown",
      fetchedAt: createdAt,
    },
    local: {
      root: designDir(slug),
      vendorDir: vendorDir(slug),
      manifestPath: manifestPath(slug),
      capabilitiesPath: capabilitiesPath(slug),
      skillDir: skillDir(slug),
    },
    skill: {
      name: skillName,
      path: skillDir(slug),
      entrypoint,
      referencePrompt: `Use Design Vault source-derived system "${title}". Read ${entrypoint}, ${manifestPath(slug)}, ${capabilitiesPath(slug)}, PRODUCT.md, execution/DESIGN.md, STYLE_CARD.html, and localized source images before generating. Preserve source-recognisable color relationships, typography hierarchy, image treatment, and layout rhythm; use PDF/PPTX/screenshots if exact Canva editor content matters.`,
      installCommand: `mkdir -p "\${CODEX_HOME:-$HOME/.codex}/skills" && cp -R "${skillDir(slug)}" "\${CODEX_HOME:-$HOME/.codex}/skills/${skillName}"`,
      references: [
        path.join(skillDir(slug), "references/catalog.md"),
        path.join(skillDir(slug), "references/components.md"),
        path.join(skillDir(slug), "references/tokens.md"),
        path.join(skillDir(slug), "references/capture.md"),
        path.join(skillDir(slug), "references/checklist.md"),
      ],
    },
    riskNotes: [
      "License is unknown; verify Canva template usage rights before commercial reuse.",
      "Public Canva template pages may expose only marketing previews, not full deck structure.",
      "Canva editor links require authenticated capture or user-confirmed export for exact content.",
    ],
  });
}

async function nextAvailableSlug(baseSlug: string) {
  let attempt = baseSlug || "canva-design-system";
  let suffix = 1;
  while (await pathExists(designDir(attempt))) {
    suffix += 1;
    attempt = `${baseSlug}-${suffix}`;
  }
  return attempt;
}

function ensureCanvaJob(job: IngestionJob) {
  if (job.mode !== "canva-template" && job.mode !== "canva-editor") {
    throw new Error(`runCanvaIngestion can only handle Canva jobs; received ${job.mode}.`);
  }
}

export async function runCanvaIngestion(jobId: string) {
  await ensureDataRoots();
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  ensureCanvaJob(job);

  const running = {
    ...job,
    status: "running" as const,
    stage: "fetching-source" as const,
    stageLabel: "正在读取 Canva 来源",
    progress: 20,
    updatedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  };
  await saveJob(running);

  try {
    const source = parseCanvaSource(job.url);
    if (source.kind !== job.mode) throw new Error(`Canva source mode mismatch: expected ${job.mode}, parsed ${source.kind}.`);
    const metadata = await metadataWithCache(source);
    const title = compactText(metadata.title || source.inferredTitle, 120) || "Canva design system";
    const baseSlug = slugify(title) || source.slugBase;
    const slug = job.targetSlug && isSafeDesignSlug(job.targetSlug) ? job.targetSlug : await nextAvailableSlug(baseSlug);
    const createdAt = new Date().toISOString();
    await resetDesignDir(slug, job.targetSlug ? "refresh-canva-ingestion" : "canva-ingestion");

    const capabilities = buildCapabilities(source, metadata);
    const tokens = buildTokens(title, metadata.description);
    const assets = await collectCanvaAssets(slug, source, metadata, title, tokens);
    const manifest = createManifest(source, slug, title, metadata, capabilities, createdAt);
    const evidence = buildEvidence(source, metadata, title, capabilities, tokens, assets);
    const heuristicProfile = buildProfile(source, metadata, title, capabilities, tokens, assets);
    const synthesis = await synthesizeCanvaProfile(evidence, tokens, heuristicProfile);
    const modelProfile = synthesis.profile;
    const profile = hasLocalizedSourceVisuals(assets) && !synthesis.error
      ? mergeCanvaModelProfile(modelProfile, heuristicProfile)
      : {
          ...heuristicProfile,
          synthesis: modelProfile.synthesis,
          evidenceSummary: synthesis.error
            ? modelProfile.evidenceSummary
            : uniqueStrings([
                ...heuristicProfile.evidenceSummary,
                "Model synthesis completed, but no localized source preview image was available; kept the source-grounded heuristic protocol to avoid title-only style invention.",
              ]),
        };
    const summary = manifest.summary;

    const meta: DesignMeta = withExecutionProtocolPaths({
      slug,
      title,
      sourceUrl: source.url,
      sourceHost: source.host,
      sourceMode: source.kind,
      requestedSourceUrl: source.url,
      sourceChain: evidence.sourceChain,
      status: "ready",
      summary,
      tags: normalizeTags([
        packageTypeTag(manifest.packageType),
        "Canva",
        source.kind === "canva-template" ? "Canva 模板" : "Canva 编辑器",
        "模板图片",
        ...capabilities.slice(0, 5).map((capability) => capability.id),
      ]),
      createdAt,
      updatedAt: createdAt,
      designPath: designDocPath(slug),
      openSlideThemePath: openSlideThemePath(slug),
      evidencePath: evidencePath(slug),
      profilePath: profilePath(slug),
      manifestPath: manifestPath(slug),
      capabilitiesPath: capabilitiesPath(slug),
      skillPath: skillPath(slug),
      packageManifest: manifest,
      capabilities,
      assets,
      previews: { web: previewPath(slug, "web"), ppt: previewPath(slug, "ppt"), card: previewPath(slug, "card") },
      tokens,
      profile,
    });
    const cardPreview = await generateStyleCardPreview(meta);
    const pptDeckPreview = await generatePptDeckPreview(meta);

    await writeJson(manifestPath(slug), manifest);
    await writeJson(capabilitiesPath(slug), capabilities);
    await writeSkillPackage(slug, manifest, capabilities, tokens);
    await writeText(designDocPath(slug), buildDesignMd(profile, source.host, source.kind, evidence));
    await writeText(openSlideThemePath(slug), buildOpenSlideTheme(profile));
    await writeJson(tokensPath(slug), tokens);
    await writeJson(sourcePath(slug), {
      input: source.input,
      kind: source.kind,
      normalizedUrl: source.url,
      host: source.host,
      canvaId: source.id,
      fetchedAt: createdAt,
      metadata,
      assets,
      captureMode: source.kind === "canva-template" ? "template-image" : "authenticated-editor",
      recommendedUpgrade: source.kind === "canva-editor" ? "Export PDF/PPTX from Canva or capture authenticated page screenshots for exact content." : "Use authenticated browser capture if the public template page does not expose enough preview images.",
    });
    await writeJson(evidencePath(slug), evidence);
    await writeJson(profilePath(slug), profile);
    await writeText(previewPath(slug, "web"), renderWebPreview(meta));
    await writeText(previewPath(slug, "ppt"), pptDeckPreview.html);
    await writeText(previewPath(slug, "card"), cardPreview.html);
    await writeExecutionProtocol(meta, cardPreview.html);
    await writeRouterSkill(meta);
    await writeJson(designMetaPath(slug), meta);

    await saveJob({
      ...running,
      status: "completed",
      stage: "completed",
      stageLabel: "导入完成",
      progress: 100,
      slug,
      error: undefined,
      diagnostics: undefined,
      updatedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });
  } catch (error) {
    const modelRequest = getModelRequestDiagnostics(error);
    await saveJob({
      ...running,
      status: "failed",
      stage: "failed",
      stageLabel: "导入失败",
      progress: 100,
      error: error instanceof Error ? error.message : String(error),
      diagnostics: modelRequest ? { modelRequest } : running.diagnostics,
      updatedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });
    throw error;
  }
}
