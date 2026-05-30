import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

import * as cheerio from "cheerio";

import { generatePptDeckPreview, generateStyleCardPreview } from "./card-preview";
import { buildDesignMd, buildOpenSlideTheme } from "./design-md";
import { withExecutionProtocolPaths, writeExecutionProtocol, writeRouterSkill } from "./execution-protocol";
import { updateJobProgress } from "./job-progress";
import { getModelRequestDiagnostics } from "./model-request";
import { renderPptPreview, renderWebPreview } from "./preview";
import { evaluateDesignQuality } from "./quality";
import { synthesizeDesignProfile } from "./synthesis";
import {
  designAssetsDir,
  designDir,
  designDocPath,
  evidencePath,
  designMetaPath,
  ensureDataRoots,
  getJob,
  isSafeDesignSlug,
  openSlideThemePath,
  pathExists,
  previewPath,
  profilePath,
  resetDesignDir,
  saveJob,
  sourcePath,
  tokensPath,
  writeJson,
  writeText,
} from "./storage";
import { modeTag, normalizeTags, packageTypeTag } from "./tags";
import type {
  AssetKind,
  AssetRecord,
  BehaviorSignal,
  DesignEvidence,
  DesignMeta,
  DesignSystemProfile,
  DesignTokens,
  ExtractedSection,
  ResponsiveSignal,
  RenderedColorCandidate,
  RoleEvidence,
  SourceChainEntry,
  VisualCrossCheck,
  VisualJourneyStep,
  VisualMediaArtifact,
} from "./types";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const execFileAsync = promisify(execFile);
type CheerioSelection = ReturnType<cheerio.CheerioAPI>;
type PlaywrightBrowser = Awaited<ReturnType<(typeof import("playwright"))["chromium"]["launch"]>>;
type PlaywrightContext = Awaited<ReturnType<PlaywrightBrowser["newContext"]>>;
type PlaywrightVideo = ReturnType<Awaited<ReturnType<PlaywrightContext["newPage"]>>["video"]>;

type ResolvedSource = {
  requestedUrl: URL;
  pageUrl: URL;
  html: string;
  $: cheerio.CheerioAPI;
  sourceChain: SourceChainEntry[];
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isBotChallengeHtml(text: string) {
  const sample = text.slice(0, 4096).toLowerCase();
  return (
    sample.includes("just a moment") ||
    sample.includes("cf-mitigated") ||
    sample.includes("challenges.cloudflare.com") ||
    sample.includes("enable javascript and cookies")
  );
}

function isKnownShortenerHost(hostname: string) {
  const root = registrableHost(hostname);
  return [
    "bit.ly",
    "buff.ly",
    "cutt.ly",
    "is.gd",
    "lnkd.in",
    "ow.ly",
    "rebrand.ly",
    "shorturl.at",
    "t.co",
    "tiny.cc",
    "tinyurl.com",
    "v.gd",
  ].includes(root);
}

function cleanFetchFailure(url: string, fetchError: unknown, curlError?: unknown) {
  const target = new URL(url);
  const shortenerHint = isKnownShortenerHost(target.hostname) ? " This is a short-link host; paste the final destination URL instead of the shortened URL." : "";
  const raw = `${errorMessage(fetchError)} ${curlError ? errorMessage(curlError) : ""}`.toLowerCase();
  if (raw.includes("403") || raw.includes("cloudflare") || raw.includes("cf-mitigated") || raw.includes("just a moment")) {
    return new Error(`Unable to fetch ${url}: the host returned a bot-protection or 403 challenge.${shortenerHint}`);
  }
  return new Error(`Unable to fetch ${url}: ${errorMessage(fetchError)}${curlError ? `; curl fallback: ${errorMessage(curlError)}` : ""}`);
}

async function fetchTextWithFallback(url: string) {
  let fetchError: unknown;
  try {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (isBotChallengeHtml(text)) throw new Error("Bot-protection challenge HTML");
    return text;
  } catch (error) {
    fetchError = error;
  }

  try {
    const { stdout } = await execFileAsync("curl", ["-L", "--fail", "--silent", "--show-error", "-A", USER_AGENT, url], {
      maxBuffer: 20 * 1024 * 1024,
      encoding: "utf8",
    });
    if (isBotChallengeHtml(stdout)) throw new Error("Bot-protection challenge HTML");
    return stdout;
  } catch (curlError) {
    throw cleanFetchFailure(url, fetchError, curlError);
  }
}

async function fetchBufferWithFallback(url: string) {
  let fetchError: unknown;
  try {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    fetchError = error;
  }

  try {
    const { stdout } = await execFileAsync("curl", ["-L", "--fail", "--silent", "--show-error", "-A", USER_AGENT, url], {
      maxBuffer: 20 * 1024 * 1024,
      encoding: "buffer",
    });
    return stdout as Buffer;
  } catch (curlError) {
    throw cleanFetchFailure(url, fetchError, curlError);
  }
}

function slugify(input: string) {
  return input.toLowerCase().replace(/https?:\/\//g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function getPageTitle($: cheerio.CheerioAPI, pageUrl: URL) {
  return $("meta[property='og:site_name']").attr("content") || $("meta[property='og:title']").attr("content") || $("title").text().trim() || pageUrl.hostname;
}

function pageDescription($: cheerio.CheerioAPI) {
  return $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "";
}

function registrableHost(hostname: string) {
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
  return parts.slice(-2).join(".");
}

function isKnownShowcaseHost(hostname: string) {
  return ["awwwards.com", "siteinspire.com"].includes(registrableHost(hostname));
}

function isBlockedOutboundHost(hostname: string) {
  if (isKnownShortenerHost(hostname)) return true;
  const root = registrableHost(hostname);
  return [
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "pinterest.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "google.com",
    "googletagmanager.com",
    "awwwards.com",
    "siteinspire.com",
  ].includes(root);
}

function candidateScore($link: CheerioSelection, href: string) {
  const text = compactText($link.text() || $link.attr("aria-label") || $link.attr("title") || "", 120).toLowerCase();
  const attrs = `${$link.attr("class") ?? ""} ${$link.attr("id") ?? ""} ${$link.attr("data-action") ?? ""} ${$link.attr("rel") ?? ""}`.toLowerCase();
  let score = 0;
  if (/visit\s*site|visit\s*website|view\s*site|open\s*site|launch|website|live\s*site/.test(text)) score += 100;
  if (/visit-count|external|outbound|website|launch/.test(attrs)) score += 55;
  if ($link.attr("target") === "_blank") score += 12;
  if (/share|intent|facebook|linkedin|twitter|pinterest|mailto/.test(href.toLowerCase())) score -= 200;
  if (/privacy|terms|cookies|about|contact|jobs|academy|market|directory/.test(text)) score -= 80;
  return score;
}

function findShowcasePrimaryUrl($: cheerio.CheerioAPI, pageUrl: URL) {
  if (!isKnownShowcaseHost(pageUrl.hostname)) return null;

  const candidates = $("a[href]")
    .toArray()
    .map((node) => {
      const $link = $(node);
      const href = $link.attr("href");
      if (!href) return null;
      const absolute = absoluteHttpUrl(pageUrl, href);
      if (!absolute) return null;
      const url = new URL(absolute);
      if (registrableHost(url.hostname) === registrableHost(pageUrl.hostname)) return null;
      if (isBlockedOutboundHost(url.hostname)) return null;
      return {
        url,
        text: compactText($link.text() || $link.attr("aria-label") || $link.attr("title") || "", 120),
        score: candidateScore($link, absolute),
      };
    })
    .filter((item): item is { url: URL; text: string; score: number } => !!item)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score < 40) return null;
  return best;
}

async function resolvePrimarySource(requestedUrl: URL, requestedHtml: string): Promise<ResolvedSource> {
  const requested$ = cheerio.load(requestedHtml);
  const requestedTitle = getPageTitle(requested$, requestedUrl);
  const sourceChain: SourceChainEntry[] = [
    {
      role: "requested",
      url: requestedUrl.toString(),
      host: requestedUrl.hostname,
      title: requestedTitle,
      note: "User-provided URL.",
    },
  ];

  const primary = findShowcasePrimaryUrl(requested$, requestedUrl);
  if (!primary) {
    return {
      requestedUrl,
      pageUrl: requestedUrl,
      html: requestedHtml,
      $: requested$,
      sourceChain,
    };
  }

  sourceChain[0] = {
    ...sourceChain[0],
    role: "showcase",
    note: `Showcase/gallery page. Primary site resolved from outbound link "${primary.text || primary.url.hostname}".`,
  };

  try {
    const primaryHtml = await fetchTextWithFallback(primary.url.toString());
    const primary$ = cheerio.load(primaryHtml);
    sourceChain.push({
      role: "primary",
      url: primary.url.toString(),
      host: primary.url.hostname,
      title: getPageTitle(primary$, primary.url),
      note: `Resolved primary website from ${requestedUrl.hostname}; design evidence should be extracted from this page.`,
    });
    return {
      requestedUrl,
      pageUrl: primary.url,
      html: primaryHtml,
      $: primary$,
      sourceChain,
    };
  } catch {
    sourceChain.push({
      role: "primary",
      url: primary.url.toString(),
      host: primary.url.hostname,
      title: primary.text || primary.url.hostname,
      note: "Primary website candidate was found but could not be fetched; falling back to requested page.",
    });
    return {
      requestedUrl,
      pageUrl: requestedUrl,
      html: requestedHtml,
      $: requested$,
      sourceChain,
    };
  }
}

function cleanHex(hex: string) {
  const value = hex.trim().replace(/;$/, "").toLowerCase();
  if (!/^#([0-9a-f]{3,8})$/i.test(value)) return null;
  if (value.length === 4) return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  if (value.length === 7) return value;
  if (value.length === 9) return value.slice(0, 7);
  return null;
}

function namedCssColor(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "black") return "#000000";
  if (normalized === "white") return "#ffffff";
  if (normalized === "transparent") return null;
  return null;
}

function rgbCssColor(value: string) {
  const match = value.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!match) return null;
  const channels = match.slice(1, 4).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))));
  if (channels.some((channel) => !Number.isFinite(channel))) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function cssVariableMap(cssText: string) {
  const variables = new Map<string, string>();
  for (const match of cssText.matchAll(/--([a-z0-9_-]+)\s*:\s*([^;}{]+)/gi)) {
    variables.set(`--${match[1].toLowerCase()}`, match[2].trim());
  }
  return variables;
}

function resolveCssColor(value: string, variables: Map<string, string>, depth = 0): string | null {
  if (depth > 4) return null;
  const trimmed = value.trim().replace(/!important$/i, "").trim();
  const varMatch = trimmed.match(/^var\(\s*(--[a-z0-9_-]+)(?:\s*,\s*([^)]+))?\)$/i);
  if (varMatch) {
    const variable = variables.get(varMatch[1].toLowerCase()) ?? varMatch[2];
    return variable ? resolveCssColor(variable, variables, depth + 1) : null;
  }
  const hexMatch = trimmed.match(/#(?:[0-9a-fA-F]{3,8})\b/);
  if (hexMatch) return cleanHex(hexMatch[0]);
  return namedCssColor(trimmed) ?? rgbCssColor(trimmed);
}

function findSemanticColorVariable(variables: Map<string, string>, patterns: RegExp[]) {
  for (const [name, value] of variables.entries()) {
    if (!patterns.some((pattern) => pattern.test(name))) continue;
    const color = resolveCssColor(value, variables);
    if (color) return color;
  }
  return undefined;
}

function hasRootColorSelector(selectorList: string) {
  return selectorList
    .split(",")
    .map((selector) => selector.trim())
    .some((selector) => /^(html|body|:root)$/i.test(selector));
}

function extractCssColorRoles(cssText: string) {
  const variables = cssVariableMap(cssText);
  let background: string | undefined;
  let text: string | undefined;
  for (const match of cssText.matchAll(/(^|})\s*([^{}]+)\{([^}]*)\}/g)) {
    if (!hasRootColorSelector(match[2])) continue;
    const declarations = match[3];
    const bg = declarations.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;}{]+)/i)?.[1];
    const fg = declarations.match(/(?:^|;)\s*color\s*:\s*([^;}{]+)/i)?.[1];
    background ??= bg ? resolveCssColor(bg, variables) ?? undefined : undefined;
    text ??= fg ? resolveCssColor(fg, variables) ?? undefined : undefined;
  }
  background ??= findSemanticColorVariable(variables, [
    /(?:^|-)bg(?:$|-)/,
    /background/,
    /surface/,
    /canvas/,
    /page/,
    /body/,
  ]);
  text ??= findSemanticColorVariable(variables, [
    /(?:^|-)fg(?:$|-)/,
    /foreground/,
    /(?:^|-)text(?:$|-)/,
    /ink/,
    /on-background/,
    /on-surface/,
  ]);
  return { background, text };
}

function hexToRgb(hex: string) {
  const normalized = cleanHex(hex);
  if (!normalized) return null;
  const raw = normalized.slice(1);
  return { r: Number.parseInt(raw.slice(0, 2), 16), g: Number.parseInt(raw.slice(2, 4), 16), b: Number.parseInt(raw.slice(4, 6), 16) };
}

function luminance(hex: string) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const values = [rgb.r, rgb.g, rgb.b].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLum = luminance(foreground);
  const backgroundLum = luminance(background);
  const lighter = Math.max(foregroundLum, backgroundLum);
  const darker = Math.min(foregroundLum, backgroundLum);
  return (lighter + 0.05) / (darker + 0.05);
}

function saturation(hex: string) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const values = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return 0;
  const light = (max + min) / 2;
  return light > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

function hue(hex: string) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const raw = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return Math.round(raw * 60 + 360) % 360;
}

function hueWithin(value: string, start: number, end: number) {
  const degrees = hue(value);
  if (degrees === null) return false;
  if (start <= end) return degrees >= start && degrees <= end;
  return degrees >= start || degrees <= end;
}

function dedupe<T>(items: T[]) {
  return [...new Set(items)];
}

function collectColorCandidates(hexes: string[]) {
  const counts = new Map<string, number>();
  for (const value of hexes) {
    const cleaned = cleanHex(value);
    if (!cleaned) continue;
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 16);
}

function chooseColors(hexes: string[]): DesignTokens["colors"] {
  const candidates = collectColorCandidates(hexes);
  if (candidates.length === 0) {
    return {
      primary: "#111827",
      secondary: "#6b7280",
      success: "#6b7280",
      warning: "#6b7280",
      danger: "#6b7280",
      surface: "#ffffff",
      text: "#111827",
      neutral: "#f3f4f6",
    };
  }

  const values = candidates.map((candidate) => candidate.value);
  const dominant = candidates[0].value;
  const dominantLum = luminance(dominant);
  const dominantLooksLikeCanvas = dominantLum < 0.14 || dominantLum > 0.86;
  const surface = dominantLooksLikeCanvas ? dominant : [...values].sort((a, b) => luminance(b) - luminance(a))[0];
  const surfaceLum = luminance(surface);
  const text =
    candidates
      .filter((candidate) => candidate.value !== surface && contrastRatio(candidate.value, surface) >= 4.5)
      .sort((a, b) => b.count - a.count)[0]?.value ?? (surfaceLum < 0.5 ? "#ffffff" : "#111827");
  const minimumAccentCount = Math.max(2, candidates[0].count * 0.08);
  const primary =
    candidates
      .filter((candidate) => candidate.value !== surface && candidate.value !== text)
      .filter((candidate) => candidate.count >= minimumAccentCount)
      .filter((candidate) => saturation(candidate.value) > 0.24 && luminance(candidate.value) > 0.12 && luminance(candidate.value) < 0.82)
      .sort((a, b) => b.count - a.count || saturation(b.value) - saturation(a.value))[0]?.value ?? text;
  const secondary =
    candidates
      .filter((candidate) => candidate.value !== surface && candidate.value !== text && candidate.value !== primary)
      .filter((candidate) => Math.abs(luminance(candidate.value) - luminance(text)) > 0.12)
      .filter((candidate) => saturation(candidate.value) < 0.16 && contrastRatio(candidate.value, surface) >= 2)
      .sort((a, b) => b.count - a.count)[0]?.value ?? (surfaceLum < 0.5 ? "#8a8a8a" : "#6b7280");
  const statusColor = (start: number, end: number) =>
    candidates
      .filter((candidate) => candidate.count >= 2)
      .filter((candidate) => saturation(candidate.value) > 0.24 && luminance(candidate.value) > 0.12 && luminance(candidate.value) < 0.82)
      .find((candidate) => hueWithin(candidate.value, start, end))?.value ?? secondary;

  return {
    primary,
    secondary,
    success: statusColor(80, 165),
    warning: statusColor(20, 65),
    danger: statusColor(340, 20),
    surface,
    text,
    neutral: secondary,
  };
}

const VISUAL_CAPTURE_VIEWPORT = {
  width: 1440,
  height: 1100,
  deviceScaleFactor: 1,
};

type RenderedViewportSample = {
  pageHeight: number;
  scrollY: number;
  visibleText: string[];
  sectionLabels: string[];
  colorCandidates: Array<Omit<RenderedColorCandidate, "stepId">>;
  hoverTarget?: {
    x: number;
    y: number;
    label: string;
  };
  warnings: string[];
};

function roleHintForRenderedColor(value: string, coverage: number) {
  if (saturation(value) > 0.32 && coverage >= 0.18) return "large accent field";
  if (saturation(value) > 0.32) return "accent / interaction color";
  if (luminance(value) < 0.16 && coverage >= 0.3) return "dark visual field";
  if (luminance(value) > 0.86 && coverage >= 0.3) return "light visual field";
  return coverage >= 0.18 ? "large neutral field" : undefined;
}

function aggregateRenderedDominantColors(steps: VisualJourneyStep[]): VisualCrossCheck["dominantColors"] {
  const colors = new Map<string, { maxCoverage: number; seen: Set<string> }>();
  for (const step of steps) {
    for (const candidate of step.colorCandidates) {
      const current = colors.get(candidate.value) ?? { maxCoverage: 0, seen: new Set<string>() };
      current.maxCoverage = Math.max(current.maxCoverage, candidate.coverage);
      current.seen.add(step.id);
      colors.set(candidate.value, current);
    }
  }
  return [...colors.entries()]
    .map(([value, item]) => ({
      value,
      coverage: Math.min(1, Number(item.maxCoverage.toFixed(3))),
      seenInSteps: item.seen.size,
      roleHint: roleHintForRenderedColor(value, item.maxCoverage),
    }))
    .sort((a, b) => b.coverage - a.coverage || b.seenInSteps - a.seenInSteps || saturation(b.value) - saturation(a.value))
    .slice(0, 10);
}

function buildRenderedJourneySummary(steps: VisualJourneyStep[], dominantColors: VisualCrossCheck["dominantColors"]) {
  const viewportSteps = steps.filter((step) => step.action !== "hover");
  const hoverSteps = steps.filter((step) => step.action === "hover");
  const labels = dedupe(viewportSteps.flatMap((step) => step.sectionLabels).filter(Boolean)).slice(0, 5);
  const dominant = dominantColors[0];
  return [
    `${viewportSteps.length} rendered viewport(s) sampled across the scroll journey${hoverSteps.length ? ` plus ${hoverSteps.length} hover state(s)` : ""}.`,
    dominant ? `Most representative rendered field: ${dominant.value} at ${Math.round(dominant.coverage * 100)}% max viewport coverage${dominant.roleHint ? ` (${dominant.roleHint})` : ""}.` : undefined,
    labels.length ? `Representative visible sections: ${labels.join(" / ")}.` : undefined,
    "Use rendered scroll/hover evidence as a cross-check over static DOM/CSS frequency and first-frame impressions.",
  ].filter((item): item is string => Boolean(item));
}

function visualColorHexMatches(visualCrossCheck?: VisualCrossCheck) {
  const values: string[] = [];
  for (const color of visualCrossCheck?.dominantColors ?? []) {
    const weight = Math.max(1, Math.min(56, Math.round(color.coverage * 56) + color.seenInSteps * 2));
    values.push(...Array.from({ length: weight }, () => color.value));
  }
  return values;
}

function mergeRenderedColorCandidates(
  cssCandidates: Array<{ value: string; count: number }>,
  visualCrossCheck?: VisualCrossCheck,
): DesignEvidence["colorCandidates"] {
  const merged = new Map<string, { value: string; count: number; source?: "css" | "rendered"; coverage?: number }>();
  for (const candidate of cssCandidates) {
    merged.set(candidate.value, { ...candidate, source: "css" });
  }
  for (const color of visualCrossCheck?.dominantColors ?? []) {
    const existing = merged.get(color.value);
    const renderedCount = Math.max(2, Math.round(color.coverage * 80) + color.seenInSteps * 5);
    merged.set(color.value, {
      value: color.value,
      count: (existing?.count ?? 0) + renderedCount,
      source: existing ? undefined : "rendered",
      coverage: Math.max(existing?.coverage ?? 0, color.coverage),
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.count - a.count || (b.coverage ?? 0) - (a.coverage ?? 0))
    .slice(0, 18);
}

function visualJourneyAssets(visualCrossCheck: VisualCrossCheck | undefined, pageUrl: URL): AssetRecord[] {
  const videoAssets: AssetRecord[] = (visualCrossCheck?.mediaArtifacts ?? [])
    .filter((artifact) => artifact.kind === "video")
    .map((artifact) => ({
      kind: "video" as const,
      name: "experience motion journey",
      path: artifact.path,
      sourceUrl: pageUrl.toString(),
    }));
  const screenshotAssets = (visualCrossCheck?.steps ?? [])
    .filter((step) => step.screenshotPath && step.action !== "hover")
    .map((step, index) => ({
      kind: "image" as const,
      name: `rendered viewport ${index + 1}`,
      path: step.screenshotPath!,
      sourceUrl: `${pageUrl.toString()}#scroll-y-${Math.round(step.y)}`,
    }));

  return [...videoAssets, ...screenshotAssets];
}

function representativeStepPositions(pageHeight: number, viewportHeight: number) {
  const maxScroll = Math.max(0, pageHeight - viewportHeight);
  const positions = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maxScroll * ratio));
  return dedupe(positions).filter((value, index) => index === 0 || Math.abs(value - positions[index - 1]) > 80);
}

function renderedViewportSampler(): RenderedViewportSample {
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const warnings: string[] = [];

  const cssColorToHex = (value: string | null | undefined) => {
    const normalized = (value ?? "").trim().toLowerCase();
    if (!normalized || normalized === "transparent" || normalized === "none") return null;
    if (/^#[0-9a-f]{3,8}$/i.test(normalized)) {
      if (normalized.length === 4) return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`;
      return normalized.slice(0, 7);
    }
    const rgb = normalized.match(/^rgba?\(([^)]+)\)/);
    if (!rgb) return null;
    const parts = rgb[1].match(/[\d.]+/g)?.map(Number) ?? [];
    if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length >= 4 && parts[3] === 0) return null;
    const [r, g, b] = parts.slice(0, 3).map((part) => Math.max(0, Math.min(255, Math.round(part))));
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  };

  const visibleRect = (element: Element) => {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const area = width * height;
    if (area < 96) return null;
    return { left, top, right, bottom, width, height, area, style };
  };

  const labelFor = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const className = typeof element.className === "string" ? element.className : "";
    const klass = className
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => `.${part}`)
      .join("");
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 42);
    return `${tag}${id}${klass}${text ? ` ${text}` : ""}`.slice(0, 96);
  };

  const colors = new Map<string, Omit<RenderedColorCandidate, "stepId">>();
  const addColor = (value: string | null | undefined, source: RenderedColorCandidate["source"], coverage: number, sample: string) => {
    const hex = cssColorToHex(value);
    if (!hex) return;
    const key = `${hex}:${source}`;
    const existing = colors.get(key);
    colors.set(key, {
      value: hex,
      source,
      coverage: Math.min(1, (existing?.coverage ?? 0) + coverage),
      count: (existing?.count ?? 0) + 1,
      sample: existing?.sample ?? sample,
    });
  };

  const elements = Array.from(
    document.querySelectorAll("body, main, section, header, nav, footer, article, form, div, a, button, input, textarea, svg, path, rect, circle"),
  ).slice(0, 4500);

  for (const element of elements) {
    const visible = visibleRect(element);
    if (!visible) continue;
    const coverage = visible.area / viewportArea;
    const sample = labelFor(element);
    addColor(visible.style.backgroundColor, "background", coverage, sample);
    for (const color of visible.style.backgroundImage.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}\b/gi) ?? []) {
      addColor(color, "background", coverage * 0.6, sample);
    }
    if ((element.textContent ?? "").trim()) {
      addColor(visible.style.color, "text", Math.min(0.08, coverage * 0.16), sample);
    }
    addColor(visible.style.borderTopColor, "border", Math.min(0.04, coverage * 0.08), sample);
    if (element instanceof SVGElement) {
      addColor(visible.style.fill, "graphic", Math.min(0.12, coverage * 0.5), sample);
      addColor(visible.style.stroke, "graphic", Math.min(0.08, coverage * 0.35), sample);
    }
  }

  const visibleText = Array.from(document.querySelectorAll("h1,h2,h3,p,a,button,label,input,textarea,[role='button']"))
    .map((element) => {
      if (!visibleRect(element)) return "";
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return element.value || element.placeholder || element.getAttribute("aria-label") || "";
      }
      return element.textContent || element.getAttribute("aria-label") || "";
    })
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((text, index, all) => all.indexOf(text) === index)
    .slice(0, 14);

  const sectionLabels = Array.from(document.querySelectorAll("header,nav,main,section,article,form,footer,[role='banner'],[role='main'],[role='contentinfo']"))
    .map((element) => (visibleRect(element) ? labelFor(element) : ""))
    .filter(Boolean)
    .filter((text, index, all) => all.indexOf(text) === index)
    .slice(0, 8);

  const hoverElement = Array.from(document.querySelectorAll("a[href],button,[role='button'],input,textarea,select"))
    .map((element) => ({ element, visible: visibleRect(element) }))
    .find(({ visible }) => visible && visible.width >= 20 && visible.height >= 20);
  const hoverTarget = hoverElement?.visible
    ? {
        x: Math.round((hoverElement.visible.left + hoverElement.visible.right) / 2),
        y: Math.round((hoverElement.visible.top + hoverElement.visible.bottom) / 2),
        label: labelFor(hoverElement.element),
      }
    : undefined;

  const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight);
  if (colors.size === 0) warnings.push("No rendered colors detected in viewport.");

  return {
    pageHeight,
    scrollY: window.scrollY,
    visibleText,
    sectionLabels,
    colorCandidates: [...colors.values()]
      .sort((a, b) => b.coverage - a.coverage || b.count - a.count)
      .slice(0, 14)
      .map((candidate) => ({ ...candidate, coverage: Number(candidate.coverage.toFixed(3)) })),
    hoverTarget,
    warnings,
  };
}

async function sampleRenderedViewport(page: { evaluate: (expression: string) => Promise<RenderedViewportSample> }) {
  const samplerSource = `(${renderedViewportSampler.toString()})`;
  return page.evaluate(`(() => { const __name = (target) => target; const sampler = eval(${JSON.stringify(samplerSource)}); return sampler(); })()`);
}

async function captureRenderedVisualJourney(pageUrl: URL, slug: string): Promise<VisualCrossCheck | undefined> {
  if (process.env.DESIGN_VAULT_VISUAL_CAPTURE === "0") return undefined;

  const steps: VisualJourneyStep[] = [];
  const mediaArtifacts: VisualMediaArtifact[] = [];
  const warnings: string[] = [];
  const capturedAt = new Date().toISOString();
  const viewport = VISUAL_CAPTURE_VIEWPORT;
  let pageHeight = viewport.height;
  let browser: PlaywrightBrowser | undefined;
  let context: PlaywrightContext | undefined;
  let recordedVideo: PlaywrightVideo | undefined;

  try {
    const { chromium } = await import("playwright");
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      warnings.push("Bundled Chromium unavailable; used installed Chrome channel for rendered visual capture.");
      browser = await chromium.launch({ channel: "chrome", headless: true });
    }
    const captureDir = path.join(designAssetsDir(slug), "visual-journey");
    await mkdir(captureDir, { recursive: true });
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      recordVideo: {
        dir: captureDir,
        size: { width: viewport.width, height: viewport.height },
      },
    });
    const page = await context.newPage();
    recordedVideo = page.video();
    page.setDefaultTimeout(12000);
    await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {
      warnings.push("Network idle was not reached; captured DOMContentLoaded visual states.");
    });
    await page.waitForTimeout(600);

    pageHeight = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight));
    const positions = representativeStepPositions(pageHeight, viewport.height);
    let hoverCaptures = 0;

    for (const [index, y] of positions.entries()) {
      await page.evaluate((targetY: number) => window.scrollTo({ top: targetY, behavior: "smooth" }), y);
      await page.waitForTimeout(850);
      const sample = await sampleRenderedViewport(page);
      const id = index === 0 ? "load-viewport" : `scroll-viewport-${index + 1}`;
      const screenshotPath = `assets/visual-journey/${id}.jpg`;
      let savedScreenshot = true;
      await page.screenshot({ path: path.join(designDir(slug), screenshotPath), type: "jpeg", quality: 72, fullPage: false }).catch((error: unknown) => {
        savedScreenshot = false;
        warnings.push(`Screenshot failed for ${id}: ${errorMessage(error)}`);
      });
      if (savedScreenshot) {
        mediaArtifacts.push({
          kind: "image",
          path: screenshotPath,
          mimeType: "image/jpeg",
          role: "keyframe",
          stepId: id,
          description: `${index === 0 ? "Initial loaded viewport" : `Scroll keyframe ${index + 1}`} at ${Math.round((pageHeight > viewport.height ? sample.scrollY / (pageHeight - viewport.height) : 0) * 100)}% page progress.`,
          modelEligible: index < 5,
        });
      }
      steps.push({
        id,
        action: index === 0 ? "load" : "scroll",
        y: sample.scrollY,
        scrollRatio: pageHeight > viewport.height ? Number((sample.scrollY / (pageHeight - viewport.height)).toFixed(3)) : 0,
        screenshotPath,
        visibleText: sample.visibleText,
        sectionLabels: sample.sectionLabels,
        colorCandidates: sample.colorCandidates.map((candidate) => ({ ...candidate, stepId: id })),
        notes: sample.warnings,
      });

      if (sample.hoverTarget && hoverCaptures < 2) {
        await page.mouse.move(sample.hoverTarget.x, sample.hoverTarget.y);
        await page.waitForTimeout(450);
        const hoverSample = await sampleRenderedViewport(page);
        const hoverId = `hover-state-${hoverCaptures + 1}`;
        const hoverScreenshotPath = `assets/visual-journey/${hoverId}.jpg`;
        let savedHoverScreenshot = true;
        await page.screenshot({ path: path.join(designDir(slug), hoverScreenshotPath), type: "jpeg", quality: 72, fullPage: false }).catch((error: unknown) => {
          savedHoverScreenshot = false;
          warnings.push(`Screenshot failed for ${hoverId}: ${errorMessage(error)}`);
        });
        if (savedHoverScreenshot) {
          mediaArtifacts.push({
            kind: "image",
            path: hoverScreenshotPath,
            mimeType: "image/jpeg",
            role: "keyframe",
            stepId: hoverId,
            description: `Hover keyframe for "${sample.hoverTarget.label}" at ${Math.round((pageHeight > viewport.height ? hoverSample.scrollY / (pageHeight - viewport.height) : 0) * 100)}% page progress.`,
            modelEligible: true,
          });
        }
        steps.push({
          id: hoverId,
          action: "hover",
          y: hoverSample.scrollY,
          scrollRatio: pageHeight > viewport.height ? Number((hoverSample.scrollY / (pageHeight - viewport.height)).toFixed(3)) : 0,
          screenshotPath: hoverScreenshotPath,
          visibleText: hoverSample.visibleText,
          sectionLabels: hoverSample.sectionLabels,
          colorCandidates: hoverSample.colorCandidates.map((candidate) => ({ ...candidate, stepId: hoverId })),
          notes: [`Hovered ${sample.hoverTarget.label}.`, ...hoverSample.warnings],
        });
        hoverCaptures += 1;
      }
    }

    await context.close();
    context = undefined;
    if (recordedVideo) {
      const rawVideoPath = await recordedVideo.path().catch(() => "");
      if (rawVideoPath) {
        const videoPath = path.join(captureDir, "motion-journey.webm");
        await rename(rawVideoPath, videoPath).catch(() => undefined);
        mediaArtifacts.push({
          kind: "video",
          path: "assets/visual-journey/motion-journey.webm",
          mimeType: "video/webm",
          role: "motion-journey",
          description: "Recorded page load, smooth scroll progression, and safe hover states for media-first design abstraction.",
          modelEligible: false,
        });
      }
    }
  } catch (error) {
    warnings.push(`Rendered visual journey capture failed: ${errorMessage(error)}`);
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  const dominantColors = aggregateRenderedDominantColors(steps);
  return {
    method: "media-first-rendered-journey",
    capturedAt,
    viewport,
    pageHeight,
    steps,
    mediaArtifacts,
    dominantColors,
    representativeSummary: buildRenderedJourneySummary(steps, dominantColors),
    warnings,
  };
}

function normalizeFamily(raw: string) {
  return raw
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .find(
      (part) =>
        part &&
        !part.startsWith("var(") &&
        !["inherit", "initial", "system-ui", "sans-serif", "serif", "monospace"].includes(part),
    ) ?? raw.trim();
}

// Patterns that mark a font candidate as unreliable for downstream display /
// body role assignment. We KEEP them in the raw candidate list (they're
// useful evidence) but downstream selection should de-rank them — see
// fontCandidateScore() below.
const FONT_NOISE_PATTERNS: RegExp[] = [
  /\bunlicensed\b/i,
  /\btrial\b/i,
  /\bplaceholder\b/i,
  /\bfallback\b/i,
  /\bdraft\b/i,
];

export function isNoisyFontCandidate(family: string) {
  if (!family) return false;
  return FONT_NOISE_PATTERNS.some((pattern) => pattern.test(family));
}

function isUsableFontFamily(input: string) {
  return (
    !!input &&
    !/^(inherit|initial|unset|ui-sans-serif|ui-serif|ui-monospace)$/i.test(input) &&
    !/^_[a-z0-9]{5,}$/i.test(input) &&
    !input.startsWith("var(")
  );
}

// Lower score = preferred. Use this when picking a single display/body
// representative from a noisy candidate list.
export function fontCandidateScore(family: string) {
  if (!family) return 100;
  let score = 0;
  if (isNoisyFontCandidate(family)) score += 50;
  if (/placeholder/i.test(family)) score += 50;
  if (/\bplaceholder\b/i.test(family)) score += 20;
  if (family.length > 50) score += 5;
  return score;
}

function extractFonts(cssText: string) {
  const familyMatches = [...cssText.matchAll(/font-family\s*:\s*([^;}{]+)/gi)].map((match) => normalizeFamily(match[1]));
  // Sort by score so "Unlicensed Trial" / "Placeholder" candidates drift to
  // the tail of the role-selection list. They stay in the evidence list, but
  // won't be picked as the canonical display/body face.
  const families = dedupe(familyMatches)
    .filter(isUsableFontFamily)
    .sort((a, b) => fontCandidateScore(a) - fontCandidateScore(b));
  const cleanFamilies = families.filter((f) => !isNoisyFontCandidate(f));
  const primary = cleanFamilies[0] ?? families[0] ?? "Inter";
  const pickDisplay = (pool: string[]) =>
    pool.find((family) => /display|serif|grotesk|grotesque|playfair|garamond|georgia/i.test(family));
  const display = pickDisplay(cleanFamilies) ?? pickDisplay(families) ?? primary;
  const mono =
    cleanFamilies.find((family) => /mono|code|jetbrains|menlo|sf mono|consolas/i.test(family)) ??
    families.find((family) => /mono|code|jetbrains|menlo|sf mono|consolas/i.test(family)) ??
    "JetBrains Mono";
  return {
    scale: ["14", "16", "18", "24", "32", "40"],
    families: { primary, display, mono },
    weights: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  };
}

function extractFontCandidates(cssText: string) {
  const familyMatches = [...cssText.matchAll(/font-family\s*:\s*([^;}{]+)/gi)].map((match) => normalizeFamily(match[1]));
  // Sort by score so noisy trial fonts trail the list (they still survive
  // as raw evidence — synthesizers can see them but downstream selection
  // logic prefers cleaner candidates).
  return dedupe(familyMatches)
    .filter(isUsableFontFamily)
    .sort((a, b) => fontCandidateScore(a) - fontCandidateScore(b))
    .slice(0, 16);
}

// Convert a length token to a pixel number when we can. Accepts px, rem,
// em (assuming 16px root). Returns null for clamp(), calc(), %, vw, etc.
// since those don't map cleanly to a static scale.
function lengthToPx(raw: string): number | null {
  const v = raw.trim().toLowerCase();
  const px = v.match(/^([\d.]+)px$/);
  if (px) return Number(px[1]);
  const rem = v.match(/^([\d.]+)rem$/);
  if (rem) return Number(rem[1]) * 16;
  const em = v.match(/^([\d.]+)em$/);
  if (em) return Number(em[1]) * 16;
  if (/^\d+$/.test(v)) return Number(v);
  return null;
}

/**
 * Pull every `border-radius:` value from the CSS bundle, normalise to px,
 * count occurrences. Returns a frequency-sorted list — the synthesiser
 * then picks a small set (xs/sm/md/lg/xl/full) representative of the
 * source's real radius vocabulary.
 *
 * Filters out anything > 200px and < 0 since those are typically
 * decorative one-offs rather than reusable design tokens. The pill
 * shape (>= 999px) survives as a separate "full" detection step
 * upstream of this.
 */
export function extractRadiusCandidates(cssText: string): Array<{ px: number; count: number }> {
  const matches = [...cssText.matchAll(/border-radius\s*:\s*([^;}{]+)/gi)];
  const tally = new Map<number, number>();
  for (const match of matches) {
    const raw = match[1].trim();
    // border-radius can be shorthand: take the first token
    const first = raw.split(/\s+/)[0];
    const px = lengthToPx(first);
    if (px === null || px < 0 || px > 200) continue;
    const rounded = Math.round(px);
    tally.set(rounded, (tally.get(rounded) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([px, count]) => ({ px, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

/**
 * Pull `transition-duration: 200ms`, `transition: 0.2s ease`,
 * `animation: …`, etc. Normalise to milliseconds.
 *
 * The synthesiser uses the median + spread of these to classify the
 * site's motion posture: tight cluster around 150-200ms = restrained
 * (Ant Design-style), long tails into 400ms+ = dramatic (Material
 * Emphasized-style).
 */
export function extractDurationCandidates(cssText: string): Array<{ ms: number; count: number }> {
  const matches = [
    ...cssText.matchAll(/transition-duration\s*:\s*([^;}{]+)/gi),
    ...cssText.matchAll(/animation-duration\s*:\s*([^;}{]+)/gi),
    ...cssText.matchAll(/transition\s*:[^;}{]*?(\d+\.?\d*\s*m?s)/gi),
  ];
  const tally = new Map<number, number>();
  for (const match of matches) {
    const raw = match[1].trim().split(/[,\s]/)[0];
    const sec = raw.match(/^([\d.]+)s$/);
    const ms = raw.match(/^([\d.]+)ms$/);
    let value: number | null = null;
    if (ms) value = Number(ms[1]);
    else if (sec) value = Number(sec[1]) * 1000;
    if (value === null || value < 30 || value > 2000) continue;
    const rounded = Math.round(value / 10) * 10;
    tally.set(rounded, (tally.get(rounded) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([ms, count]) => ({ ms, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

/**
 * Pull `transition-timing-function: cubic-bezier(…)` plus the easing
 * keyword forms (`ease`, `ease-in`, `ease-out`, `ease-in-out`). Each
 * keyword maps to its canonical cubic-bezier; downstream rendering then
 * has a single representation to work with.
 */
export function extractEasingCandidates(cssText: string): Array<{ curve: string; count: number }> {
  const KEYWORD_MAP: Record<string, string> = {
    ease: "cubic-bezier(0.25, 0.1, 0.25, 1)",
    "ease-in": "cubic-bezier(0.42, 0, 1, 1)",
    "ease-out": "cubic-bezier(0, 0, 0.58, 1)",
    "ease-in-out": "cubic-bezier(0.42, 0, 0.58, 1)",
    linear: "cubic-bezier(0, 0, 1, 1)",
  };
  const tally = new Map<string, number>();
  const cubicMatches = [...cssText.matchAll(/cubic-bezier\(\s*([\d.\s,\-]+)\s*\)/gi)];
  for (const match of cubicMatches) {
    const parts = match[1].split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) continue;
    const normalised = `cubic-bezier(${parts.map((n) => Number(n.toFixed(3))).join(", ")})`;
    tally.set(normalised, (tally.get(normalised) ?? 0) + 1);
  }
  const keywordMatches = [...cssText.matchAll(/transition-timing-function\s*:\s*([a-z\-]+)/gi)];
  for (const match of keywordMatches) {
    const kw = match[1].trim().toLowerCase();
    const curve = KEYWORD_MAP[kw];
    if (curve) tally.set(curve, (tally.get(curve) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([curve, count]) => ({ curve, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

/**
 * Pull every `font-size:` value, normalise to px, dedupe + sort. Then
 * compute the geometric ratio between the most-common adjacent sizes
 * to classify the type scale against the standard musical-interval
 * table (1.067 Minor 2nd … 1.618 Golden Ratio).
 *
 * Returns the candidate size set + the detected ratio name + numeric
 * ratio. The synthesiser uses this to set `tokens.primitive.fontSize`
 * deterministically rather than asking the AI to invent it.
 */
export function extractFontSizeRatio(cssText: string): {
  sizesPx: number[];
  detectedRatio: number;
  detectedRatioName: string;
} {
  const matches = [...cssText.matchAll(/font-size\s*:\s*([^;}{]+)/gi)];
  const tally = new Map<number, number>();
  for (const match of matches) {
    const raw = match[1].trim();
    const px = lengthToPx(raw);
    if (px === null || px < 8 || px > 200) continue;
    const rounded = Math.round(px * 2) / 2; // 0.5px resolution
    tally.set(rounded, (tally.get(rounded) ?? 0) + 1);
  }
  const sizesPx = [...tally.keys()].sort((a, b) => a - b);
  // Compute ratios between adjacent observed sizes that occur ≥2 times
  // (filters out one-off decorative sizes).
  const heavy = [...tally.entries()].filter(([, c]) => c >= 2).map(([s]) => s).sort((a, b) => a - b);
  const ratios: number[] = [];
  for (let i = 1; i < heavy.length; i++) {
    const prev = heavy[i - 1];
    const cur = heavy[i];
    if (prev > 0) ratios.push(cur / prev);
  }
  const medianRatio = ratios.length ? ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)] : 1.25;
  // Snap to nearest standard interval.
  const SCALE_TABLE: Array<{ name: string; ratio: number }> = [
    { name: "Minor Second", ratio: 1.067 },
    { name: "Major Second", ratio: 1.125 },
    { name: "Minor Third", ratio: 1.2 },
    { name: "Major Third", ratio: 1.25 },
    { name: "Perfect Fourth", ratio: 1.333 },
    { name: "Augmented Fourth", ratio: 1.414 },
    { name: "Perfect Fifth", ratio: 1.5 },
    { name: "Golden Ratio", ratio: 1.618 },
  ];
  const nearest = SCALE_TABLE.reduce((best, entry) =>
    Math.abs(entry.ratio - medianRatio) < Math.abs(best.ratio - medianRatio) ? entry : best,
  );
  return {
    sizesPx,
    detectedRatio: Number(medianRatio.toFixed(3)),
    detectedRatioName: nearest.name,
  };
}

function assetFilename(base: string, fallbackExt: string) {
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "asset";
  return `${safe}.${fallbackExt}`;
}

async function downloadAsset(assetUrl: string, destination: string) {
  const buffer = await fetchBufferWithFallback(assetUrl);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, buffer);
}

async function saveInlineSvg(slug: string, svg: string, index: number) {
  const relativePath = path.join("assets", assetFilename(`inline-icon-${index + 1}`, "svg"));
  const absolutePath = path.join(designDir(slug), relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, svg, "utf8");
  return relativePath;
}

function firstSrcsetUrl(value: string | undefined) {
  return value
    ?.split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .find(Boolean);
}

function isLikelyImageUrl(assetUrl: string) {
  try {
    const pathname = new URL(assetUrl).pathname.toLowerCase();
    return /\.(?:png|jpe?g|webp|avif|gif|svg|ico)$/i.test(pathname);
  } catch {
    return false;
  }
}

function addAssetCandidate(
  candidates: Array<{ url: string; kind: AssetKind; name: string }>,
  seen: Set<string>,
  pageUrl: URL,
  rawUrl: string | undefined,
  kind: AssetKind,
  name: string,
) {
  if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) return;
  const url = absoluteHttpUrl(pageUrl, rawUrl);
  if (!url || seen.has(url)) return;
  seen.add(url);
  candidates.push({ url, kind, name });
}

function assetCandidateScore(candidate: { url: string; kind: AssetKind; name: string }) {
  const corpus = `${candidate.name} ${candidate.url}`.toLowerCase();
  let score = 0;
  if (candidate.kind === "image") score += 40;
  if (candidate.kind === "logo") score += 20;
  if (candidate.kind === "svg") score += 8;
  if (/hero|cover|main|lead|masthead|banner|poster|og-image|twitter-image|source-image/.test(corpus)) score += 80;
  if (/background|bg|inline-bg|css-image/.test(corpus)) score += 45;
  if (/product|case|work|gallery|project|photo|image/.test(corpus)) score += 25;
  if (/\.(?:webp|avif|jpe?g|png)(?:[?#]|$)/.test(corpus) || /\/_next\/image\?/.test(corpus)) score += 18;
  if (/logo|brand|mark/.test(corpus)) score += candidate.kind === "logo" ? 22 : -18;
  if (/favicon|sprite|icon-|apple-touch|mask-icon|placeholder|loader|pixel|tracking/.test(corpus)) score -= 90;
  return score;
}

function extractCssImageUrls(cssText: string) {
  return [...cssText.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/gi)]
    .map((match) => match[1])
    .filter((url) => !/\.(?:woff2?|ttf|otf|eot)(?:[?#].*)?$/i.test(url));
}

async function collectAssets($: cheerio.CheerioAPI, slug: string, pageUrl: URL, cssText = "") {
  const results: AssetRecord[] = [];
  await mkdir(designAssetsDir(slug), { recursive: true });
  const candidates: Array<{ url: string; kind: AssetKind; name: string }> = [];
  const seen = new Set<string>();

  $("link[rel*='icon']").each((_, element) => {
    const href = $(element).attr("href");
    addAssetCandidate(candidates, seen, pageUrl, href, "icon", "favicon");
  });

  addAssetCandidate(candidates, seen, pageUrl, $("meta[property='og:image']").attr("content"), "image", "og-image");
  addAssetCandidate(candidates, seen, pageUrl, $("meta[name='twitter:image']").attr("content"), "image", "twitter-image");

  const logoImage = $("img[alt*='logo' i], img[src*='logo' i]").first().attr("src");
  addAssetCandidate(candidates, seen, pageUrl, logoImage, "logo", "logo");

  $("img").slice(0, 48).each((index, element) => {
    const $image = $(element);
    const rawUrl = $image.attr("src") || $image.attr("data-src") || firstSrcsetUrl($image.attr("srcset") || $image.attr("data-srcset"));
    const corpus = `${$image.attr("alt") ?? ""} ${$image.attr("class") ?? ""} ${rawUrl ?? ""}`.toLowerCase();
    const kind: AssetKind = /logo|brand|mark/.test(corpus) ? "logo" : "image";
    const name = /hero|cover|main|first|lead/.test(corpus) ? "hero-image" : kind === "logo" ? "logo" : `dom-image-${index + 1}`;
    addAssetCandidate(candidates, seen, pageUrl, rawUrl, kind, name);
  });

  $("source[srcset]").slice(0, 24).each((index, element) => {
    addAssetCandidate(candidates, seen, pageUrl, firstSrcsetUrl($(element).attr("srcset")), "image", `source-image-${index + 1}`);
  });

  $("[style*='url(']").slice(0, 24).each((index, element) => {
    for (const rawUrl of extractCssImageUrls($(element).attr("style") ?? "").slice(0, 3)) {
      addAssetCandidate(candidates, seen, pageUrl, rawUrl, "image", `inline-bg-${index + 1}`);
    }
  });

  for (const [index, rawUrl] of extractCssImageUrls(cssText).entries()) {
    const absolute = absoluteHttpUrl(pageUrl, rawUrl);
    if (!absolute || !isLikelyImageUrl(absolute)) continue;
    addAssetCandidate(candidates, seen, pageUrl, rawUrl, "image", `css-image-${index + 1}`);
    if (candidates.filter((candidate) => candidate.name.startsWith("css-image")).length >= 18) break;
  }

  const rank = (items: Array<{ url: string; kind: AssetKind; name: string }>) =>
    items
      .map((candidate, index) => ({ candidate, index, score: assetCandidateScore(candidate) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.candidate);

  const selectedCandidates = [
    ...candidates.filter((candidate) => candidate.kind === "icon").slice(0, 4),
    ...rank(candidates.filter((candidate) => candidate.kind === "logo")).slice(0, 3),
    ...rank(candidates.filter((candidate) => candidate.kind === "image")).slice(0, 18),
  ];

  for (const [index, candidate] of selectedCandidates.entries()) {
    try {
      const ext = path.extname(new URL(candidate.url).pathname).replace(".", "") || "png";
      const relativePath = path.join("assets", assetFilename(`${candidate.name}-${index + 1}`, ext));
      const absolutePath = path.join(designDir(slug), relativePath);
      if (!(await pathExists(absolutePath))) await downloadAsset(candidate.url, absolutePath);
      results.push({ kind: candidate.kind, name: candidate.name, path: relativePath, sourceUrl: candidate.url });
    } catch {}
  }

  const inlineSvgs = $("svg").slice(0, 12).toArray();
  for (const [index, svgNode] of inlineSvgs.entries()) {
    const markup = $.html(svgNode);
    if (!markup.includes("<svg")) continue;
    const relativePath = await saveInlineSvg(slug, markup, index);
    results.push({ kind: "svg", name: `inline-icon-${index + 1}`, path: relativePath });
  }

  return results;
}

function absoluteHttpUrl(base: URL, maybeUrl: string) {
  try {
    const url = new URL(maybeUrl, base);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// Generic boilerplate descriptions that vendors stamp on every page they host.
// When we see these, we'd rather use the AI-synthesised summary later than
// surface them in the library card.
const GENERIC_DESCRIPTION_PATTERNS: RegExp[] = [
  /^made with framer\.?$/i,
  /^created (?:with|on) framer\.?$/i,
  /^(?:powered by|built with) (?:framer|webflow|wix|squarespace|carrd|notion)\.?$/i,
  /^a (?:framer|webflow|wix|squarespace) (?:website|site)\.?$/i,
  /^(?:website|site|portfolio|landing page|coming soon)\.?$/i,
];

export function isGenericDescription(description: string) {
  const trimmed = description.trim();
  if (!trimmed) return true;
  if (trimmed.length < 20) return true;
  return GENERIC_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function summarize(title: string, description: string, host: string) {
  const trimmed = description.trim();
  if (trimmed.length > 0 && !isGenericDescription(trimmed)) {
    return trimmed.slice(0, 220);
  }
  return `${title} extracted from ${host} and normalized into a reusable design system for web and slide generation.`;
}

// After synthesis runs, the AI's `profile.summary` is usually richer than the
// page's og:description. Prefer it when the raw description was vendor
// boilerplate ("Made with Framer") or substantively shorter than what the
// model wrote.
export function pickBestSummary(rawDescription: string, syntheticSummary: string | undefined) {
  const synth = (syntheticSummary || "").trim();
  if (!synth) return rawDescription;
  const raw = rawDescription.trim();
  if (isGenericDescription(raw)) return synth.slice(0, 280);
  if (synth.length >= raw.length + 40) return synth.slice(0, 280);
  return raw;
}

function uniqueTexts(values: Array<string | undefined>, limit: number) {
  return dedupe(
    values
      .map((value) => value?.replace(/\s+/g, " ").trim())
      .filter((value): value is string => !!value && value.length > 0),
  ).slice(0, limit);
}

function isNoisyControlLabel(label: string) {
  return /^(search|cookie preferences|manage cookies|accept all|reject all|privacy settings)$/i.test(label.trim());
}

function compactText(value: string | undefined, limit = 220) {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function nodeTag(node: unknown) {
  const candidate = node as { tagName?: string; name?: string };
  return (candidate.tagName ?? candidate.name ?? "node").toLowerCase();
}

function selectorFor($: cheerio.CheerioAPI, node: unknown, index: number) {
  const $node = $(node as never);
  const tag = nodeTag(node);
  const id = $node.attr("id");
  if (id) return `${tag}#${id}`;
  const classes = ($node.attr("class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (classes.length > 0) return `${tag}.${classes.join(".")}`;
  const role = $node.attr("role");
  if (role) return `${tag}[role="${role}"]`;
  return `${tag}:nth-of-type(${index + 1})`;
}

function inferSectionRole($node: CheerioSelection, tag: string) {
  const corpus = `${tag} ${$node.attr("id") ?? ""} ${$node.attr("class") ?? ""} ${$node.attr("role") ?? ""} ${compactText($node.text(), 300)}`.toLowerCase();
  if (/nav|menu|header|banner/.test(corpus) || tag === "nav" || tag === "header") return "nav" as const;
  if (/hero|headline|intro|masthead|above[-_ ]?fold/.test(corpus) || $node.find("h1").length > 0) return "hero" as const;
  if (/price|plan|billing/.test(corpus)) return "pricing" as const;
  if (/faq|question|accordion/.test(corpus)) return "faq" as const;
  if (/sponsor|partner|logo wall|logo-wall/.test(corpus)) return "sponsor" as const;
  if (/form|signup|contact|subscribe/.test(corpus) || tag === "form" || $node.find("form, input, textarea, select").length > 0) return "form" as const;
  if (/feature|benefit|capabilit|solution|product/.test(corpus)) return "feature" as const;
  if (/footer|contentinfo/.test(corpus) || tag === "footer") return "footer" as const;
  if (tag === "section" || tag === "article" || tag === "main") return "content" as const;
  return "unknown" as const;
}

function collectClassCorpus($: cheerio.CheerioAPI, $node: CheerioSelection) {
  return [
    $node.attr("class") ?? "",
    ...$node
      .find("[class]")
      .slice(0, 40)
      .toArray()
      .map((child) => $(child).attr("class") ?? ""),
  ]
    .join(" ")
    .toLowerCase();
}

function extractSections($: cheerio.CheerioAPI): ExtractedSection[] {
  const nodes = $("header, nav, main, main > section, section, article, footer, form, [role='banner'], [role='main'], [role='contentinfo']")
    .toArray()
    .slice(0, 28);

  return nodes
    .map((node, index) => {
      const $node = $(node as never);
      const tag = nodeTag(node);
      const classCorpus = collectClassCorpus($, $node);
      const componentHints = [
        /card|tile|panel/.test(classCorpus) ? "card-like surface" : "",
        /button|btn|cta/.test(classCorpus) || $node.find("button, [role='button'], a[class*='button'], a[class*='btn']").length > 0 ? "button / CTA" : "",
        /grid|columns|stack|row|col/.test(classCorpus) ? "layout grid" : "",
        /table|row|list|item/.test(classCorpus) ? "list / table row" : "",
        /accordion|faq|details/.test(classCorpus) || $node.find("details, summary").length > 0 ? "accordion / disclosure" : "",
        /tabs|tablist|tab/.test(classCorpus) || $node.find("[role='tab'], [role='tablist']").length > 0 ? "tabs" : "",
        /carousel|slider|swiper|splide/.test(classCorpus) ? "carousel / slider" : "",
        /modal|dialog|popover/.test(classCorpus) || $node.find("dialog, [popover]").length > 0 ? "dialog / popover" : "",
      ].filter(Boolean);
      const interactionHints = [
        $node.find("button, [role='button'], input[type='submit']").length > 0 ? "click target" : "",
        $node.find("a[href]").length > 0 ? "link navigation" : "",
        $node.find("[aria-expanded], details, summary").length > 0 ? "expanded / collapsed state" : "",
        $node.find("[aria-selected], [data-state], [aria-current]").length > 0 ? "selected / current state" : "",
        $node.find("form, input, textarea, select").length > 0 ? "input state" : "",
      ].filter(Boolean);
      const headings = uniqueTexts(
        $node
          .find("h1, h2, h3")
          .toArray()
          .map((heading) => $(heading).text()),
        4,
      );
      const ctas = uniqueTexts(
        $node
          .find("button, [role='button'], input[type='submit'], a[class*='button'], a[class*='btn']")
          .toArray()
          .map((cta) => $(cta).text() || $(cta).attr("value") || $(cta).attr("aria-label")),
        5,
      ).filter((label) => !isNoisyControlLabel(label));
      const links = uniqueTexts(
        $node
          .find("a[href]")
          .toArray()
          .map((link) => $(link).text() || $(link).attr("aria-label")),
        6,
      ).filter((label) => !isNoisyControlLabel(label));
      const assetRefs = uniqueTexts(
        $node
          .find("img, picture source, video, svg")
          .toArray()
          .map((asset) => $(asset).attr("alt") || $(asset).attr("src") || $(asset).attr("aria-label") || nodeTag(asset)),
        6,
      );
      const role = inferSectionRole($node, tag);
      const label = headings[0] || ctas[0] || links[0] || compactText($node.attr("aria-label") || $node.attr("id") || $node.attr("class") || tag, 80);

      return {
        id: `section-${index + 1}-${role}`,
        order: index + 1,
        tag,
        selector: selectorFor($, node, index),
        role,
        label,
        headings,
        textSample: compactText($node.text(), 260),
        ctas,
        links,
        assetRefs,
        componentHints: dedupe(componentHints),
        interactionHints: dedupe(interactionHints),
      };
    })
    .filter((section) => section.textSample || section.headings.length || section.ctas.length || section.assetRefs.length)
    .slice(0, 18);
}

function addSignal(signals: BehaviorSignal[], signal: BehaviorSignal) {
  if (signals.some((item) => item.kind === signal.kind && item.selector === signal.selector && item.evidence === signal.evidence)) return;
  signals.push(signal);
}

function extractBehaviorSignals($: cheerio.CheerioAPI, cssText: string): BehaviorSignal[] {
  const signals: BehaviorSignal[] = [];
  const hoverMatches = [...cssText.matchAll(/([^{};]+):hover[^{}]*\{/gi)].slice(0, 6);
  for (const match of hoverMatches) {
    addSignal(signals, { kind: "hover", source: "css", selector: compactText(match[1], 80), evidence: ":hover rule", confidence: "medium" });
  }

  const ruleMatches = [...cssText.matchAll(/([^{}]+)\{([^{}]+)\}/g)].slice(0, 800);
  for (const match of ruleMatches) {
    const selector = compactText(match[1], 90);
    const body = match[2];
    if (/position\s*:\s*sticky/i.test(body)) addSignal(signals, { kind: "sticky", source: "css", selector, evidence: "position: sticky", confidence: "high" });
    if (/position\s*:\s*fixed/i.test(body)) addSignal(signals, { kind: "fixed", source: "css", selector, evidence: "position: fixed", confidence: "high" });
    if (/transition\s*:/i.test(body)) addSignal(signals, { kind: "transition", source: "css", selector, evidence: compactText(body.match(/transition\s*:[^;]+/i)?.[0], 110), confidence: "medium" });
    if (/animation\s*:/i.test(body)) addSignal(signals, { kind: "animation", source: "css", selector, evidence: compactText(body.match(/animation\s*:[^;]+/i)?.[0], 110), confidence: "medium" });
    if (/scroll-snap-(type|align)\s*:/i.test(body)) addSignal(signals, { kind: "scroll-snap", source: "css", selector, evidence: compactText(body.match(/scroll-snap-[^;]+/i)?.[0], 110), confidence: "high" });
    if (signals.length >= 28) break;
  }

  if (/@keyframes/i.test(cssText)) {
    addSignal(signals, { kind: "animation", source: "css", selector: "@keyframes", evidence: "keyframe animation block exists", confidence: "medium" });
  }

  const domSignalSelectors: Array<[string, BehaviorSignal["kind"], BehaviorSignal["source"], string, BehaviorSignal["confidence"]]> = [
    ["details, summary, [aria-expanded]", "accordion", "dom", "disclosure / expanded state markup", "high"],
    ["[role='tab'], [role='tablist'], [aria-selected]", "tabs", "attribute", "tab or selected-state semantics", "high"],
    ["dialog, [popover], [role='dialog']", "dialog", "dom", "dialog / popover semantics", "high"],
    ["form, input, textarea, select", "form", "dom", "form input controls", "high"],
    ["[data-state], [aria-current], [aria-pressed], [aria-checked]", "state", "attribute", "stateful attribute", "high"],
    ["[class*='carousel'], [class*='slider'], [class*='swiper'], [class*='splide']", "carousel", "class", "carousel / slider class naming", "medium"],
  ];

  for (const [selector, kind, source, evidence, confidence] of domSignalSelectors) {
    const match = $(selector).first();
    if (match.length === 0) continue;
    addSignal(signals, { kind, source, selector, evidence, confidence });
  }

  return signals.slice(0, 32);
}

function extractResponsiveSignals(cssText: string): ResponsiveSignal[] {
  return [...cssText.matchAll(/@media\s*([^{]+)\{/gi)]
    .map((match) => ({
      breakpoint: compactText(match[1], 90),
      evidence: compactText(match[0], 120),
      affectedSelectors: [],
    }))
    .filter((signal, index, all) => all.findIndex((item) => item.breakpoint === signal.breakpoint) === index)
    .slice(0, 12);
}

export function buildRoleEvidence(profile: DesignMeta["profile"], tokens: DesignTokens, evidence: DesignEvidence): RoleEvidence[] {
  const colorCount = (value: string) => evidence.colorCandidates.find((candidate) => candidate.value.toLowerCase() === value.toLowerCase())?.count ?? 0;
  const visualColor = (value: string) => evidence.visualCrossCheck?.dominantColors.find((candidate) => candidate.value.toLowerCase() === value.toLowerCase());
  const colorEvidence = (value: string, fallback: string) => {
    const notes = [fallback];
    const count = colorCount(value);
    const rendered = visualColor(value);
    notes.push(count > 0 ? `Seen ${count} weighted time(s) across CSS/HTML plus rendered candidates.` : "Not among top static candidates; inferred from source contrast relationship and marked for visual review.");
    if (rendered) {
      notes.push(`Rendered journey shows ${value} at ${Math.round(rendered.coverage * 100)}% max viewport coverage across ${rendered.seenInSteps} step(s)${rendered.roleHint ? ` as ${rendered.roleHint}` : ""}.`);
    }
    return notes;
  };
  const colorConfidence = (value: string): RoleEvidence["confidence"] => {
    const rendered = visualColor(value);
    if (rendered && rendered.coverage >= 0.18) return "high";
    return colorCount(value) > 0 ? "medium" : "low";
  };
  const fontSeen = (value: string) => evidence.fontCandidates.find((font) => font.toLowerCase() === value.toLowerCase());
  return [
    {
      role: "background",
      value: profile.colorRoles.background,
      evidence: colorEvidence(profile.colorRoles.background, `Chosen as canvas/surface role from profile synthesis; token fallback was ${tokens.colors.surface}.`),
      confidence: colorConfidence(profile.colorRoles.background),
    },
    {
      role: "text",
      value: profile.colorRoles.text,
      evidence: colorEvidence(profile.colorRoles.text, `Chosen as foreground role from profile synthesis; token fallback was ${tokens.colors.text}.`),
      confidence: colorConfidence(profile.colorRoles.text),
    },
    {
      role: "accent",
      value: profile.colorRoles.brandPrimary,
      evidence: colorEvidence(profile.colorRoles.brandPrimary, `Chosen as primary action/brand role; token fallback was ${tokens.colors.primary}.`),
      confidence: colorConfidence(profile.colorRoles.brandPrimary),
    },
    {
      role: "secondary",
      value: profile.colorRoles.brandSecondary,
      evidence: colorEvidence(profile.colorRoles.brandSecondary, `Chosen as muted/supporting role; token fallback was ${tokens.colors.secondary}.`),
      confidence: colorConfidence(profile.colorRoles.brandSecondary),
    },
    {
      role: "display-font",
      value: profile.typographyRoles.display,
      evidence: [fontSeen(profile.typographyRoles.display) ? "Display family appears in extracted CSS font-family candidates." : "Display family inferred by profile synthesis."],
      confidence: fontSeen(profile.typographyRoles.display) ? "medium" : "low",
    },
    {
      role: "body-font",
      value: profile.typographyRoles.body,
      evidence: [fontSeen(profile.typographyRoles.body) ? "Body family appears in extracted CSS font-family candidates." : "Body family inferred by profile synthesis."],
      confidence: fontSeen(profile.typographyRoles.body) ? "medium" : "low",
    },
    {
      role: "mono-font",
      value: profile.typographyRoles.mono,
      evidence: [fontSeen(profile.typographyRoles.mono) ? "Mono family appears in extracted CSS font-family candidates." : "Mono family inferred or supplied as fallback."],
      confidence: fontSeen(profile.typographyRoles.mono) ? "medium" : "low",
    },
  ];
}

export function buildStateInventory(evidence: DesignEvidence) {
  const states = new Set<string>();
  if (evidence.interactionSignals.hasHoverStyles) states.add("hover");
  if (evidence.interactionSignals.hasTransitions) states.add("transition feedback");
  if (evidence.interactionSignals.hasAnimations) states.add("animated / keyframed state");
  if (evidence.interactionSignals.hasStickyElements) states.add("sticky / fixed scroll state");
  if (evidence.interactionSignals.hasForms) states.add("input focus / validation state");
  if (evidence.visualCrossCheck?.steps.some((step) => step.action === "scroll")) states.add("rendered scroll journey state");
  if (evidence.visualCrossCheck?.steps.some((step) => step.action === "hover")) states.add("rendered hover state");
  for (const signal of evidence.behaviorSignals ?? []) {
    if (signal.kind === "tabs") states.add("selected tab state");
    if (signal.kind === "accordion") states.add("expanded / collapsed state");
    if (signal.kind === "dialog") states.add("open / closed overlay state");
    if (signal.kind === "carousel") states.add("current slide / pagination state");
    if (signal.kind === "state") states.add("current / pressed / checked state");
  }
  return [...states].slice(0, 16);
}

function extractEvidence(
  $: cheerio.CheerioAPI,
  pageUrl: URL,
  requestedUrl: URL,
  sourceMode: DesignEvidence["sourceMode"],
  description: string,
  colorCandidates: Array<{ value: string; count: number }>,
  fontCandidates: string[],
  assets: AssetRecord[],
  cssBundle: string,
  sourceChain: SourceChainEntry[],
  visualCrossCheck?: VisualCrossCheck,
): DesignEvidence {
  const headings = uniqueTexts(
    $("h1, h2, h3")
      .toArray()
      .map((node) => $(node).text()),
    12,
  );
  const rawButtonLabels = uniqueTexts(
    $("button, [role='button'], input[type='submit'], a[class*='button'], a[class*='btn']")
      .toArray()
      .map((node) => $(node).text() || $(node).attr("value") || $(node).attr("aria-label")),
    12,
  );
  const buttonLabels = rawButtonLabels.filter((label) => !isNoisyControlLabel(label));
  const linkLabels = uniqueTexts(
    $("a")
      .toArray()
      .map((node) => $(node).text() || $(node).attr("aria-label")),
    16,
  ).filter((label) => !isNoisyControlLabel(label));

  const styleCorpus = `${$.html()}\n${cssBundle}`;
  const domSignals = {
    headingCount: $("h1, h2, h3").length,
    sectionCount: $("section, article, main").length,
    buttonCount: $("button, [role='button'], input[type='submit']").length,
    linkCount: $("a").length,
    imageCount: $("img, picture").length,
    formCount: $("form, input, textarea, select").length,
    navCount: $("nav, header").length,
    cardLikeCount: $("[class*='card'], [class*='tile'], [class*='panel']").length,
  };

  const interactionSignals = {
    hasHoverStyles: /:hover/.test(styleCorpus),
    hasAnimations: /@keyframes|animation\s*:/.test(styleCorpus),
    hasTransitions: /transition\s*:/.test(styleCorpus),
    hasStickyElements: /position\s*:\s*sticky|position\s*:\s*fixed/.test(styleCorpus),
    hasScrollSnap: /scroll-snap-type|scroll-snap-align/.test(styleCorpus),
    hasForms: domSignals.formCount > 0,
  };

  const assetSummary = {
    total: assets.length,
    icons: assets.filter((asset) => asset.kind === "icon").length,
    images: assets.filter((asset) => asset.kind === "image").length,
    logos: assets.filter((asset) => asset.kind === "logo").length,
    svgs: assets.filter((asset) => asset.kind === "svg").length,
    videos: assets.filter((asset) => asset.kind === "video").length,
  };
  const sections = extractSections($);
  const behaviorSignals = extractBehaviorSignals($, cssBundle);
  const responsiveSignals = extractResponsiveSignals(cssBundle);

  return {
    title: getPageTitle($, pageUrl),
    sourceUrl: pageUrl.toString(),
    sourceHost: pageUrl.hostname,
    sourceMode,
    requestedSourceUrl: requestedUrl.toString() === pageUrl.toString() ? undefined : requestedUrl.toString(),
    sourceChain,
    description,
    headings,
    buttonLabels,
    linkLabels,
    colorCandidates,
    fontCandidates,
    domSignals,
    interactionSignals,
    assetSummary,
    sections,
    behaviorSignals,
    responsiveSignals,
    visualCrossCheck,
    stateInventory: buildStateInventory({
      title: "",
      sourceUrl: "",
      sourceHost: "",
      sourceMode,
      description: "",
      headings: [],
      buttonLabels: [],
      linkLabels: [],
      colorCandidates: [],
      fontCandidates: [],
      domSignals,
      interactionSignals,
      assetSummary,
      behaviorSignals,
      notes: [],
    }),
    notes: [
      "Evidence is generated from HTML, CSS, meta information, static assets, rendered scroll/hover viewport checks, page topology, behavior signals, and responsive CSS hints.",
      ...(requestedUrl.toString() === pageUrl.toString()
        ? []
        : [`Requested URL was treated as showcase context; primary design extraction used ${pageUrl.toString()}.`]),
      visualCrossCheck?.steps.length
        ? "Rendered journey evidence is used to correct static CSS frequency when a scrolled viewport exposes a dominant visual field."
        : "Rendered journey capture was unavailable; treat distinctive below-fold visual fields as review-needed.",
    ],
  };
}

function buildTokens(hexes: string[], cssText: string): DesignTokens {
  const colorRoles = extractCssColorRoles(cssText);
  const colors = chooseColors(hexes);
  return {
    colors: {
      ...colors,
      surface: colorRoles.background ?? colors.surface,
      text: colorRoles.text ?? colors.text,
    },
    typography: extractFonts(cssText),
    spacing: { baseline: "8pt baseline grid", layout: "Prefer predictable columns, strong vertical rhythm, and restrained spacing changes." },
    motion: {
      transition: "150–250ms",
      easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      notes: ["Favor subtle fades and micro-lifts over theatrical motion.", "Use accent color as the interaction signal."],
    },
  };
}

function buildCssRoleEvidence(tokens: DesignTokens, cssText: string): RoleEvidence[] | undefined {
  const colorRoles = extractCssColorRoles(cssText);
  const roles: RoleEvidence[] = [];
  if (colorRoles.background) {
    roles.push({
      role: "background",
      value: colorRoles.background,
      evidence: [`Extracted from body/root background declaration or semantic CSS color variable; token surface is ${tokens.colors.surface}.`],
      confidence: "high",
    });
  }
  if (colorRoles.text) {
    roles.push({
      role: "text",
      value: colorRoles.text,
      evidence: [`Extracted from body/root color declaration or semantic CSS text variable; token text is ${tokens.colors.text}.`],
      confidence: "high",
    });
  }
  return roles.length ? roles : undefined;
}

/**
 * W6 stylesheet collection: many production sites split their CSS across
 * a dozen+ linked stylesheets. Naïvely taking the first 4 in HTML order
 * misses the actual structural CSS — for example GitHub serves 37
 * stylesheets in head order [light, light_high_contrast, dark,
 * dark_high_contrast, ..., primer-primitives, primer], so a top-4 grab
 * captures only theme-color variants (zero `border-radius:` /
 * `transition:` declarations) and leaves W1.2 extractors empty.
 *
 * Prioritisation heuristic (lower score = fetched earlier):
 *   - Deprioritise URLs that look like ALTERNATE theme variants
 *     (high_contrast, colorblind, tritanopia, dimmed). The default
 *     light/dark already covers the same primitive token shape.
 *   - Mildly deprioritise pure "dark" themes when a "light" version is
 *     also present (they share structural rules; we only need one).
 *   - Boost URLs containing recognisable structural names: "primer",
 *     "primitives", "base", "global", "main", "app", "vendor", "core".
 *
 * Hard caps (so a misconfigured page can't drain the import):
 *   - up to STYLESHEET_FETCH_LIMIT distinct URLs
 *   - up to STYLESHEET_TOTAL_BYTES_CAP combined bytes
 */
const STYLESHEET_FETCH_LIMIT = 16;
const STYLESHEET_TOTAL_BYTES_CAP = 4_000_000;
const STYLESHEET_ALT_THEME_RX = /(high[_-]contrast|colorblind|tritanopia|dimmed|protanopia|deuteranopia)/i;
const STYLESHEET_DARK_THEME_RX = /(^|[\/_-])dark([_-]|\.)/i;
const STYLESHEET_STRUCTURAL_RX = /(primer-primitives|primer|primitives|tailwind|base|global|main\.|app\.|vendor|core\.|layout|reset|normalize|fonts)/i;

function scoreStylesheetUrl(url: string, sawLightTheme: { value: boolean }): number {
  let score = 50;
  if (STYLESHEET_STRUCTURAL_RX.test(url)) score -= 30;
  if (STYLESHEET_ALT_THEME_RX.test(url)) score += 40;
  if (STYLESHEET_DARK_THEME_RX.test(url)) {
    // First dark theme stays useful (carries the same structural rules
    // as light); additional dark variants get deprioritised since by
    // then we already have light + dark covered.
    if (sawLightTheme.value) score += 20;
    else sawLightTheme.value = true;
  }
  return score;
}

async function fetchCssBundle($: cheerio.CheerioAPI, pageUrl: URL) {
  const inlineStyles = $("style").toArray().map((node) => $(node).html() ?? "").join("\n");
  const rawUrls = $("link[rel='stylesheet']")
    .toArray()
    .map((node) => absoluteHttpUrl(pageUrl, $(node).attr("href") ?? ""))
    .filter(Boolean) as string[];

  // Dedupe (GitHub's preload tags duplicate `<link rel="stylesheet">` URLs).
  const seen = new Set<string>();
  const sawLightTheme = { value: false };
  const candidates = rawUrls
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .map((url, index) => ({ url, score: scoreStylesheetUrl(url, sawLightTheme), order: index }))
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, STYLESHEET_FETCH_LIMIT)
    .map((entry) => entry.url);

  // Parallel fetch; track cumulative bytes so an outlier giant CSS
  // doesn't blow past the cap.
  let totalBytes = 0;
  const fetchedStyles = await Promise.all(candidates.map(async (url) => {
    try {
      const text = await fetchTextWithFallback(url);
      if (totalBytes + text.length > STYLESHEET_TOTAL_BYTES_CAP) {
        const remaining = Math.max(0, STYLESHEET_TOTAL_BYTES_CAP - totalBytes);
        totalBytes += remaining;
        return text.slice(0, remaining);
      }
      totalBytes += text.length;
      return text;
    } catch {
      return "";
    }
  }));
  return [inlineStyles, ...fetchedStyles].join("\n");
}

async function nextAvailableSlug(baseSlug: string) {
  let attempt = baseSlug || "design-system";
  let counter = 2;
  while (await pathExists(designDir(attempt))) {
    attempt = `${baseSlug}-${counter}`;
    counter += 1;
  }
  return attempt;
}

export async function runIngestion(jobId: string) {
  await ensureDataRoots();
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  await updateJobProgress(job, {
    status: "running",
    stage: "fetching-source",
    stageLabel: "正在抓取网页源代码",
    progress: 14,
  });

  try {
    const requestedUrl = new URL(job.url);
    if (isKnownShortenerHost(requestedUrl.hostname)) {
      throw new Error(`Shortened URLs are not stable source material for design extraction: ${requestedUrl.toString()} Paste the final destination URL instead.`);
    }
    const requestedHtml = await fetchTextWithFallback(requestedUrl.toString());
    await updateJobProgress(job, {
      stage: "resolving-source",
      stageLabel: "正在解析真实来源和页面结构",
      progress: 24,
    });
    const resolved = await resolvePrimarySource(requestedUrl, requestedHtml);
    const { pageUrl, html, $, sourceChain } = resolved;
    const pageTitle = getPageTitle($, pageUrl);
    const summary = summarize(pageTitle, pageDescription($), pageUrl.hostname);
    const baseSlug = slugify(`${pageTitle}-${pageUrl.hostname}`);
    const slug = job.targetSlug && isSafeDesignSlug(job.targetSlug) ? job.targetSlug : await nextAvailableSlug(baseSlug);
    await resetDesignDir(slug, job.targetSlug ? "refresh-url-ingestion" : "url-ingestion");
    const cssBundle = await fetchCssBundle($, pageUrl);
    const styleCorpus = `${html}\n${cssBundle}`;
    const hexMatches = [...styleCorpus.matchAll(/#(?:[0-9a-fA-F]{3,8})\b/g)].map((match) => match[0]);
    await updateJobProgress(job, {
      stage: "capturing-visuals",
      stageLabel: "正在用浏览器捕获页面视觉证据",
      progress: 38,
    });
    const visualCrossCheck = await captureRenderedVisualJourney(pageUrl, slug);
    const renderedHexMatches = visualColorHexMatches(visualCrossCheck);
    const combinedHexMatches = [...hexMatches, ...renderedHexMatches];
    const tokens = buildTokens(combinedHexMatches, cssBundle);
    await updateJobProgress(job, {
      stage: "collecting-assets",
      stageLabel: "正在整理图片、字体和交互线索",
      progress: 50,
    });
    const sourceAssets = await collectAssets($, slug, pageUrl, cssBundle);
    const assets = [...visualJourneyAssets(visualCrossCheck, pageUrl), ...sourceAssets];
    const colorCandidates = mergeRenderedColorCandidates(collectColorCandidates(hexMatches), visualCrossCheck);
    const fontCandidates = extractFontCandidates(cssBundle);
    // W1.2: deterministic extraction of visual tokens. Captured even when
    // the AI fails / is skipped, so downstream renderers always have
    // something concrete to bind to.
    const radiusCandidates = extractRadiusCandidates(cssBundle);
    const durationCandidates = extractDurationCandidates(cssBundle);
    const easingCandidates = extractEasingCandidates(cssBundle);
    const fontSizeRatio = extractFontSizeRatio(cssBundle);
    const evidence = extractEvidence($, pageUrl, requestedUrl, job.mode, summary, colorCandidates, fontCandidates, assets, cssBundle, sourceChain, visualCrossCheck);
    evidence.radiusCandidates = radiusCandidates;
    evidence.durationCandidates = durationCandidates;
    evidence.easingCandidates = easingCandidates;
    evidence.fontSizeRatio = fontSizeRatio;
    evidence.roleEvidence = buildCssRoleEvidence(tokens, cssBundle);
    await updateJobProgress(job, {
      stage: "synthesizing-profile",
      stageLabel: "正在生成设计系统抽象",
      progress: 64,
    });
    const baseProfile = await synthesizeDesignProfile(evidence, tokens, { mediaBaseDir: designDir(slug) });
    const enrichedEvidence: DesignEvidence = {
      ...evidence,
      roleEvidence: buildRoleEvidence(baseProfile, tokens, evidence),
      stateInventory: buildStateInventory(evidence),
    };
    const createdAt = new Date().toISOString();

    // Prefer the AI-synthesised summary over generic vendor boilerplate
    // ("Made with Framer" etc.) so the library card actually says something.
    const effectiveSummary = pickBestSummary(summary, baseProfile.summary);
    const baseMeta: DesignMeta = {
      slug,
      title: pageTitle,
      sourceUrl: pageUrl.toString(),
      sourceHost: pageUrl.hostname,
      sourceMode: job.mode,
      requestedSourceUrl: requestedUrl.toString() === pageUrl.toString() ? undefined : requestedUrl.toString(),
      sourceChain,
      status: "ready",
      summary: effectiveSummary,
      // archetype ("source-derived … system") is an internal classification —
      // surfaced via the package-type facet, not stored as a jargon tag chip.
      tags: normalizeTags([packageTypeTag(), modeTag(job.mode)]),
      createdAt,
      updatedAt: createdAt,
      designPath: designDocPath(slug),
      openSlideThemePath: openSlideThemePath(slug),
      evidencePath: evidencePath(slug),
      profilePath: profilePath(slug),
      assets,
      previews: { web: previewPath(slug, "web"), ppt: previewPath(slug, "ppt"), card: previewPath(slug, "card") },
      tokens,
      profile: baseProfile,
    };
    const webPreview = renderWebPreview(baseMeta);
    const pptPreview = renderPptPreview(baseMeta);
    const quality = evaluateDesignQuality({
      evidence: enrichedEvidence,
      meta: baseMeta,
      previews: { web: webPreview, ppt: pptPreview },
      profile: baseProfile,
      tokens,
    });
    const profile: DesignSystemProfile = { ...baseProfile, quality };
    const meta: DesignMeta = withExecutionProtocolPaths({ ...baseMeta, profile });
    await updateJobProgress(job, {
      stage: "rendering-previews",
      stageLabel: "正在生成卡片预览和 PPT 预览",
      progress: 82,
    });
    const cardPreview = await generateStyleCardPreview(meta);
    const pptDeckPreview = await generatePptDeckPreview(meta);

    await updateJobProgress(job, {
      stage: "writing-output",
      stageLabel: "正在写入资料库文件",
      progress: 94,
    });
    await writeText(designDocPath(slug), buildDesignMd(profile, pageUrl.hostname, job.mode, enrichedEvidence));
    await writeText(openSlideThemePath(slug), buildOpenSlideTheme(profile));
    await writeJson(tokensPath(slug), tokens);
    await writeJson(sourcePath(slug), {
      requestedUrl: requestedUrl.toString(),
      resolvedUrl: pageUrl.toString(),
      sourceChain,
      title: pageTitle,
      description: summary,
      fetchedAt: createdAt,
      cssSources: cssBundle.slice(0, 12000),
    });
    await writeJson(evidencePath(slug), enrichedEvidence);
    await writeJson(profilePath(slug), profile);
    await writeText(previewPath(slug, "web"), renderWebPreview(meta));
    await writeText(previewPath(slug, "ppt"), pptDeckPreview.html);
    await writeText(previewPath(slug, "card"), cardPreview.html);
    await writeExecutionProtocol(meta, cardPreview.html);
    await writeRouterSkill(meta);
    await writeJson(designMetaPath(slug), meta);

    await updateJobProgress(job, {
      status: "completed",
      stage: "completed",
      stageLabel: "导入完成",
      progress: 100,
      slug,
      error: undefined,
      diagnostics: undefined,
    });
  } catch (error) {
    const modelRequest = getModelRequestDiagnostics(error);
    const current = await getJob(job.id);
    await saveJob({
      ...(current ?? job),
      status: "failed",
      stage: "failed",
      stageLabel: "导入失败",
      progress: 100,
      error: error instanceof Error ? error.message : String(error),
      diagnostics: modelRequest ? { modelRequest } : current?.diagnostics ?? job.diagnostics,
      updatedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });
    throw error;
  }
}
