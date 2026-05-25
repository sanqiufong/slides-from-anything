import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { generatePptDeckPreview, generateStyleCardPreview } from "./card-preview";
import { buildDesignMd, buildOpenSlideTheme } from "./design-md";
import { withExecutionProtocolPaths, withManifestExecutionPaths, writeExecutionProtocol, writeRouterSkill } from "./execution-protocol";
import {
  extractDurationCandidates,
  extractEasingCandidates,
  extractFontSizeRatio,
  extractRadiusCandidates,
} from "./ingestion";
import { getModelRequestDiagnostics } from "./model-request";
import { requiredPresentationSampleArchetypes } from "./presentation-samples";
import { renderWebPreview } from "./preview";
import { normalizeProfileForEmission } from "./synthesis";
import { isValidHex, parseThemeMarkdown, inferThemeFileStyle } from "./theme-markdown-parser";
import type { ParsedThemeMarkdownBlock, ThemeFileStyleIdentity } from "./theme-markdown-parser";
import { resolveTypographyFromTemplate } from "./skill-evidence/font-resolver";
import type { ResolvedFontStack } from "./skill-evidence/font-resolver";
import { parseLayoutCatalog } from "./skill-evidence/layout-catalog-parser";
import type { ParsedLayoutBlock } from "./skill-evidence/layout-catalog-parser";
import { parseAntiPatternMarkdown, formatAntiPatternRule } from "./skill-evidence/lock-rules-parser";
import { parseRhythmGuidance } from "./skill-evidence/rhythm-parser";
import type { ParsedRhythm } from "./skill-evidence/rhythm-parser";
import { parseComponentCatalog } from "./skill-evidence/component-catalog-parser";
import type { ParsedComponentBlock } from "./skill-evidence/component-catalog-parser";
import { parseGridPresets, formatGridPresetSignatures } from "./skill-evidence/grid-preset-parser";
import type { ParsedGridPreset } from "./skill-evidence/grid-preset-parser";
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
  manifestPath,
  openSlideThemePath,
  pathExists,
  previewPath,
  profilePath,
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
import { normalizeTags, packageTypeTag } from "./tags";
import type {
  AssetRecord,
  DesignEvidence,
  DesignMeta,
  DesignSystemCapability,
  DesignSystemCapabilityCategory,
  DesignSystemPackageManifest,
  DesignSystemPackageType,
  DesignSystemProfile,
  DesignSystemSourceKind,
  DesignTokens,
  IngestionJob,
} from "./types";

const execFileAsync = promisify(execFile);
const PROJECT_PROMPT_VERSION = "design-system-project-compiler-v2-presentation-samples";
const USER_AGENT = "DesignVault/0.1 design-system-project-ingest";
const DEMO_IMAGE_LIMIT = 6;
const DEMO_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

type ProjectSourcePlan = {
  input: string;
  kind: DesignSystemSourceKind;
  normalizedUrl?: string;
  host?: string;
  cloneUrl?: string;
  zipUrl?: string;
  packageName?: string;
};

type MaterializedSource = ProjectSourcePlan & {
  rootDir: string;
  tempDir: string;
  packageJson?: PackageJson;
  version?: string;
  license?: string;
  repository?: string;
  commit?: string;
};

type PackageJson = {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  keywords?: string[];
  repository?: string | { url?: string; type?: string };
  homepage?: string;
  style?: string;
  sass?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type FileIndexEntry = {
  path: string;
  size: number;
  ext: string;
  kind: "asset" | "code" | "config" | "doc" | "style" | "template" | "unknown";
};

type ProjectDetection = {
  name: string;
  slugBase: string;
  packageType: DesignSystemPackageType;
  secondaryTypes: DesignSystemPackageType[];
  confidence: "low" | "medium" | "high";
  summary: string;
  bestFor: string[];
  notFor: string[];
  riskNotes: string[];
  hasRootSkill: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compactText(input: string | undefined, limit = 220) {
  const normalized = input?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}

function slugify(input: string) {
  return input.toLowerCase().replace(/https?:\/\//g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function skillSafeName(input: string) {
  const safe = slugify(input).replace(/^-|-$/g, "") || "design-system-skill";
  return safe.slice(0, 64);
}

function isNpmPackageName(input: string) {
  return /^(?:npm:)?(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(input.trim());
}

function parseRepository(value: PackageJson["repository"]) {
  if (!value) return undefined;
  const raw = typeof value === "string" ? value : value.url;
  return raw?.replace(/^git\+/, "").replace(/\.git$/, "");
}

function parseProjectSource(input: string): ProjectSourcePlan {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Please provide a GitHub repo, npm package, or zip archive source.");

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host === "github.com") {
      const [owner, repo] = url.pathname.split("/").filter(Boolean);
      if (owner && repo) {
        const normalizedUrl = `https://github.com/${owner}/${repo.replace(/\.git$/, "")}`;
        return { input: trimmed, kind: "github-repo", normalizedUrl, host, cloneUrl: `${normalizedUrl}.git` };
      }
    }
    if (host === "www.npmjs.com" || host === "npmjs.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const packageIndex = parts.indexOf("package");
      if (packageIndex >= 0 && parts[packageIndex + 1]) {
        const rawName = parts.slice(packageIndex + 1).join("/");
        return { input: trimmed, kind: "npm-package", normalizedUrl: trimmed, host, packageName: decodeURIComponent(rawName) };
      }
    }
    if (url.pathname.toLowerCase().endsWith(".zip") || url.pathname.toLowerCase().includes("/archive/") || host === "codeload.github.com") {
      return { input: trimmed, kind: "zip-archive", normalizedUrl: trimmed, host, zipUrl: trimmed };
    }
    return { input: trimmed, kind: "project-url", normalizedUrl: trimmed, host };
  } catch {
    const packageName = trimmed.replace(/^npm:/, "");
    if (isNpmPackageName(trimmed)) {
      return { input: trimmed, kind: "npm-package", packageName };
    }
  }

  throw new Error("Unsupported design-system source. MVP supports public GitHub repos, npm package names/URLs, and zip archive URLs.");
}

async function execSafe(file: string, args: string[], cwd?: string) {
  return execFileAsync(file, args, {
    cwd,
    env: { ...process.env, npm_config_yes: "true" },
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
  });
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function materializeSource(plan: ProjectSourcePlan): Promise<MaterializedSource> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "design-vault-project-"));
  const sourceRoot = path.join(tempDir, "source");

  if (plan.kind === "github-repo") {
    if (!plan.cloneUrl) throw new Error("GitHub source is missing a clone URL.");
    try {
      await execSafe("git", ["clone", "--depth", "1", plan.cloneUrl, sourceRoot]);
    } catch (error) {
      throw new Error(`Unable to clone public GitHub repo ${plan.normalizedUrl ?? plan.input}: ${errorMessage(error)}`);
    }

    const packageJson = await readJsonIfExists<PackageJson>(path.join(sourceRoot, "package.json"));
    const commit = await execSafe("git", ["rev-parse", "HEAD"], sourceRoot).then((result) => result.stdout.trim()).catch(() => undefined);
    return {
      ...plan,
      rootDir: sourceRoot,
      tempDir,
      packageJson,
      version: packageJson?.version,
      license: packageJson?.license,
      repository: parseRepository(packageJson?.repository) ?? plan.normalizedUrl,
      commit,
    };
  }

  if (plan.kind === "npm-package") {
    if (!plan.packageName) throw new Error("npm source is missing a package name.");
    let packageInfo: PackageJson | undefined;
    try {
      const { stdout } = await execSafe("npm", ["view", plan.packageName, "--json"]);
      packageInfo = JSON.parse(stdout) as PackageJson;
    } catch {
      packageInfo = undefined;
    }

    try {
      const { stdout } = await execSafe("npm", ["pack", plan.packageName, "--silent", "--pack-destination", tempDir]);
      const packedName = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!packedName) throw new Error("npm pack did not return an archive name.");
      const archivePath = path.isAbsolute(packedName) ? packedName : path.join(tempDir, packedName);
      await execSafe("tar", ["-xzf", archivePath, "-C", tempDir]);
    } catch (error) {
      throw new Error(`Unable to download npm package ${plan.packageName}: ${errorMessage(error)}`);
    }

    const packageRoot = path.join(tempDir, "package");
    const packageJson = (await readJsonIfExists<PackageJson>(path.join(packageRoot, "package.json"))) ?? packageInfo;
    return {
      ...plan,
      rootDir: packageRoot,
      tempDir,
      packageJson,
      version: packageJson?.version ?? packageInfo?.version,
      license: packageJson?.license ?? packageInfo?.license,
      repository: parseRepository(packageJson?.repository) ?? parseRepository(packageInfo?.repository),
    };
  }

  if (plan.kind === "zip-archive") {
    if (!plan.zipUrl) throw new Error("zip source is missing an archive URL.");
    const archivePath = path.join(tempDir, "archive.zip");
    const unzipDir = path.join(tempDir, "unzipped");
    try {
      await execSafe("curl", ["-L", "--fail", "--silent", "--show-error", "-A", USER_AGENT, "-o", archivePath, plan.zipUrl]);
      await mkdir(unzipDir, { recursive: true });
      await execSafe("unzip", ["-q", archivePath, "-d", unzipDir]);
    } catch (error) {
      throw new Error(`Unable to download or extract zip archive ${plan.zipUrl}: ${errorMessage(error)}`);
    }
    const entries = await readdir(unzipDir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    const rootDir = directories.length === 1 ? path.join(unzipDir, directories[0].name) : unzipDir;
    const packageJson = await readJsonIfExists<PackageJson>(path.join(rootDir, "package.json"));
    return {
      ...plan,
      rootDir,
      tempDir,
      packageJson,
      version: packageJson?.version,
      license: packageJson?.license,
      repository: parseRepository(packageJson?.repository),
    };
  }

  throw new Error("Project URL import currently supports public GitHub repos, npm package names/URLs, and zip archive URLs. Use a repository, package, or archive source.");
}

function ignoredDir(name: string) {
  return [".git", ".hg", ".svn", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache"].includes(name);
}

function fileKind(ext: string, relPath: string): FileIndexEntry["kind"] {
  const lower = relPath.toLowerCase();
  if ([".md", ".mdx", ".txt"].includes(ext)) return "doc";
  if ([".css", ".scss", ".sass", ".less"].includes(ext)) return "style";
  if ([".html", ".htm"].includes(ext)) return "template";
  if ([".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"].includes(ext)) return "code";
  if ([".json", ".yaml", ".yml", ".toml"].includes(ext) || lower.includes("package.json")) return "config";
  if ([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf"].includes(ext)) return "asset";
  return "unknown";
}

async function collectFileIndex(rootDir: string) {
  const files: FileIndexEntry[] = [];

  async function walk(dir: string, rel = "") {
    if (files.length >= 1600) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= 1600) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDir(entry.name)) await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolute).catch(() => null);
      if (!info) continue;
      const ext = path.extname(entry.name).toLowerCase();
      files.push({ path: relative, size: info.size, ext, kind: fileKind(ext, relative) });
    }
  }

  await walk(rootDir);
  return files;
}

function pathLooksImportant(relPath: string) {
  const lower = relPath.toLowerCase();
  return (
    /(^|\/)(readme|license|package\.json|skill\.md|template\.html)$/i.test(relPath) ||
    lower.startsWith("references/") ||
    lower.startsWith("assets/") ||
    lower.startsWith("docs/") ||
    lower.startsWith("examples/") ||
    lower.startsWith("components/") ||
    lower.startsWith("src/") ||
    lower.startsWith("core/scss/") ||
    lower.startsWith("core/js/") ||
    lower.startsWith("core/docs/") ||
    lower.startsWith("core/img/") ||
    lower.startsWith("dist/css/") ||
    lower.startsWith("dist/js/")
  );
}

async function copyVendorSnapshot(sourceRoot: string, targetRoot: string, fileIndex: FileIndexEntry[]) {
  await mkdir(targetRoot, { recursive: true });
  const copied: FileIndexEntry[] = [];
  let totalBytes = 0;
  const candidates = fileIndex
    .filter((file) => pathLooksImportant(file.path))
    .filter((file) => file.size <= (file.kind === "asset" ? 1_200_000 : 520_000))
    .sort((a, b) => {
      const rootScore = (item: FileIndexEntry) => (item.path.split(path.sep).length === 1 ? -10 : 0) + (item.kind === "doc" ? -4 : item.kind === "config" ? -3 : 0);
      return rootScore(a) - rootScore(b) || a.path.localeCompare(b.path);
    });

  for (const file of candidates) {
    if (copied.length >= 320 || totalBytes + file.size > 24 * 1024 * 1024) break;
    const source = path.join(sourceRoot, file.path);
    const target = path.join(targetRoot, "source", file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true });
    copied.push(file);
    totalBytes += file.size;
  }

  await writeJson(path.join(targetRoot, "index.json"), {
    schemaVersion: "1.0",
    copiedAt: new Date().toISOString(),
    copiedFiles: copied,
    totalIndexedFiles: fileIndex.length,
    note: "Design Vault stores a selected source snapshot for agent reference. Large build artifacts and dependency directories are intentionally excluded.",
  });

  return copied;
}

function activeSkillSourceReferencePaths(slug: string, copiedFiles: FileIndexEntry[]) {
  const sourceRoot = path.join(skillDir(slug), "source");
  const references = [
    path.join(skillDir(slug), "references/catalog.md"),
    path.join(skillDir(slug), "references/components.md"),
    path.join(skillDir(slug), "references/tokens.md"),
    path.join(skillDir(slug), "references/patterns.md"),
    path.join(skillDir(slug), "references/adapters.md"),
    path.join(skillDir(slug), "references/checklist.md"),
  ];

  if (copiedFiles.some((file) => file.path === "SKILL.md")) {
    references.push(path.join(sourceRoot, "SKILL.md"));
  }
  for (const dirName of ["references", "assets", "scripts"] as const) {
    if (copiedFiles.some((file) => file.path.startsWith(`${dirName}/`))) {
      references.push(path.join(sourceRoot, dirName));
    }
  }
  return references;
}

async function copyActiveSkillSourceSnapshot(slug: string, copiedFiles: FileIndexEntry[]) {
  const vendorSourceRoot = path.join(vendorDir(slug), "source");
  const activeSourceRoot = path.join(skillDir(slug), "source");
  await rm(activeSourceRoot, { recursive: true, force: true });
  await mkdir(activeSourceRoot, { recursive: true });

  const sourceItems = [
    "SKILL.md",
    "README.md",
    "README.en.md",
    "LICENSE",
    "references",
    "assets",
    "scripts",
  ];
  const copiedActivePaths: string[] = [];

  for (const item of sourceItems) {
    const source = path.join(vendorSourceRoot, item);
    if (!(await pathExists(source))) continue;
    const target = path.join(activeSourceRoot, item);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
    copiedActivePaths.push(path.join("source", item));
  }

  if (!copiedActivePaths.length) {
    for (const file of copiedFiles.filter((item) => item.path === "SKILL.md" || item.path.startsWith("references/") || item.path.startsWith("assets/") || item.path.startsWith("scripts/"))) {
      const source = path.join(vendorSourceRoot, file.path);
      if (!(await pathExists(source))) continue;
      const target = path.join(activeSourceRoot, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true });
      copiedActivePaths.push(path.join("source", file.path));
    }
  }

  await writeJson(path.join(activeSourceRoot, "materialized.json"), {
    schemaVersion: "1.0",
    materializedAt: new Date().toISOString(),
    note: "These files are copied from vendor/source so an installed Design Vault skill can read the upstream package without depending on the Design Vault record path.",
    copiedPaths: copiedActivePaths,
  });
  return copiedActivePaths;
}

function decodeMaybeUri(input: string) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function stripImageSource(input: string) {
  return input.trim().replace(/^<|>$/g, "").replace(/&amp;/g, "&").split(/\s+(?=["'])/)[0];
}

function imageExtFromMime(contentType: string | null) {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/svg+xml") return ".svg";
  return "";
}

function imageExtFromPath(value: string) {
  const ext = path.extname(value.split(/[?#]/)[0]).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext) ? ext : "";
}

function isNoisyReadmeImage(src: string, alt = "") {
  const text = `${src} ${alt}`.toLowerCase();
  return /(shields\.io|badge|badgen|github\/workflows|actions\/workflows|coveralls|codecov|npm\/v|npm\/dm|license|discord|twitter|x\.com|linkedin|sponsor|favicon|icon-|\/icons\/|\/flags\/|\/logo)/i.test(text);
}

function normalizeRemoteImageUrl(src: string) {
  try {
    const url = new URL(src.startsWith("//") ? `https:${src}` : src);
    if (url.hostname === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const blobIndex = parts.indexOf("blob");
      const rawIndex = parts.indexOf("raw");
      const markerIndex = blobIndex >= 0 ? blobIndex : rawIndex;
      if (parts[0] && parts[1] && markerIndex >= 0 && parts[markerIndex + 1]) {
        const owner = parts[0];
        const repo = parts[1];
        const ref = parts[markerIndex + 1];
        const filePath = parts.slice(markerIndex + 2).join("/");
        return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
      }
    }
    return url.toString();
  } catch {
    return "";
  }
}

function githubRepositoryParts(source: MaterializedSource) {
  const raw = source.normalizedUrl ?? source.repository ?? "";
  try {
    const url = new URL(raw.replace(/^git\+/, ""));
    if (url.hostname !== "github.com") return null;
    const [owner, repoWithSuffix] = url.pathname.split("/").filter(Boolean);
    const repo = repoWithSuffix?.replace(/\.git$/i, "");
    return owner && repo ? { owner, repo } : null;
  } catch {
    const match = raw.match(/github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/i);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  }
}

async function readGithubRenderedReadmeImageRefs(source: MaterializedSource) {
  if (source.kind !== "github-repo") return [];
  const repo = githubRepositoryParts(source);
  if (!repo) return [];
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/readme`;
  const response = await fetch(url, {
    headers: {
      "accept": "application/vnd.github.html+json",
      "user-agent": USER_AGENT,
    },
  }).catch(() => null);
  if (!response?.ok) return [];
  const html = await response.text().catch(() => "");
  if (!html) return [];
  return readmeImageRefs(html, "README.md");
}

function githubBlobUrl(source: MaterializedSource, relPath: string) {
  if (!source.normalizedUrl || !source.commit) return undefined;
  return `${source.normalizedUrl}/blob/${source.commit}/${relPath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

function resolveLocalImageRef(source: MaterializedSource, docPath: string, src: string) {
  const rawPath = decodeMaybeUri(stripImageSource(src).split(/[?#]/)[0]);
  if (!rawPath || rawPath.startsWith("data:") || rawPath.startsWith("//") || /^[a-z]+:/i.test(rawPath)) return null;
  const baseDir = rawPath.startsWith("/") ? source.rootDir : path.dirname(path.join(source.rootDir, docPath));
  const absolute = path.resolve(baseDir, rawPath.replace(/^\/+/, ""));
  const root = path.resolve(source.rootDir);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  const relative = path.relative(root, absolute);
  return { absolute, relative };
}

function readmeImageRefs(content: string, docPath: string) {
  const refs: Array<{ alt: string; docPath: string; src: string }> = [];
  for (const match of content.matchAll(/!\[([^\]]*)\]\(([^)\n]+)\)/g)) {
    refs.push({ alt: match[1] ?? "", docPath, src: stripImageSource(match[2] ?? "") });
  }
  for (const match of content.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const tag = match[0] ?? "";
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "";
    refs.push({ alt, docPath, src: stripImageSource(match[1] ?? "") });
  }
  return refs.filter((ref) => ref.src && !isNoisyReadmeImage(ref.src, ref.alt));
}

function docPriority(file: FileIndexEntry) {
  const lower = file.path.toLowerCase();
  if (lower === "readme.md" || lower === "readme.mdx") return -100;
  if (/^docs\/(index|readme)\.mdx?$/.test(lower)) return -70;
  if (/^examples?\//.test(lower)) return -45;
  if (lower.includes("showcase") || lower.includes("demo") || lower.includes("preview")) return -35;
  return file.kind === "template" ? -15 : 0;
}

function fallbackImagePriority(file: FileIndexEntry) {
  const lower = file.path.toLowerCase();
  if (!imageExtFromPath(file.path) || isNoisyReadmeImage(file.path)) return 999;
  let score = 0;
  if (/(screenshot|screen-shot|preview|demo|showcase|cover|hero|example|template)/.test(lower)) score -= 80;
  if (/^(docs|examples?|demo|preview|showcase)\//.test(lower)) score -= 30;
  if (/assets\//.test(lower)) score -= 10;
  if (/(avatar|flag|sprite|symbol|social|brand|favicon|logo)/.test(lower)) score += 120;
  return score;
}

async function writeDemoAssetFromBuffer(slug: string, index: number, buffer: Buffer, ext: string, name: string, sourceUrl?: string): Promise<AssetRecord> {
  const safeExt = ext === ".jpeg" ? ".jpg" : ext || ".png";
  const fileName = `demo-${String(index).padStart(2, "0")}${safeExt}`;
  const targetDir = path.join(designAssetsDir(slug), "project-demos");
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, fileName), buffer);
  return {
    name: compactText(name, 80) || `Project demo ${index}`,
    kind: safeExt === ".svg" ? "svg" : "image",
    path: `assets/project-demos/${fileName}`,
    sourceUrl,
  };
}

async function fetchRemoteDemoImage(url: string) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } }).catch(() => null);
  if (!response?.ok) return null;
  const contentType = response.headers.get("content-type");
  const ext = imageExtFromMime(contentType) || imageExtFromPath(url);
  if (!ext) return null;
  const size = Number(response.headers.get("content-length") ?? "0");
  if (size > DEMO_IMAGE_MAX_BYTES) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > DEMO_IMAGE_MAX_BYTES) return null;
  return { buffer, ext };
}

async function collectProjectPreviewAssets(slug: string, source: MaterializedSource, fileIndex: FileIndexEntry[]): Promise<AssetRecord[]> {
  const docFiles = fileIndex
    .filter((file) => ["doc", "template"].includes(file.kind) && file.size > 0 && file.size <= 260_000)
    .sort((a, b) => docPriority(a) - docPriority(b) || a.path.localeCompare(b.path))
    .slice(0, 36);
  const candidates: Array<{ alt: string; localPath?: string; relPath?: string; remoteUrl?: string; sourceUrl?: string }> = [];
  const seen = new Set<string>();

  for (const file of docFiles) {
    const content = await readFile(path.join(source.rootDir, file.path), "utf8").catch(() => "");
    for (const ref of readmeImageRefs(content, file.path)) {
      const local = resolveLocalImageRef(source, ref.docPath, ref.src);
      const remoteUrl = local ? undefined : normalizeRemoteImageUrl(ref.src);
      const key = local?.relative ?? remoteUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ alt: ref.alt, localPath: local?.absolute, relPath: local?.relative, remoteUrl, sourceUrl: local ? undefined : ref.src });
    }
  }

  // GitHub user-uploaded README images are stored as `github.com/user-attachments`
  // in raw Markdown, but GitHub only exposes a downloadable signed
  // `private-user-images.githubusercontent.com` URL in the rendered README HTML.
  for (const ref of await readGithubRenderedReadmeImageRefs(source)) {
    const remoteUrl = normalizeRemoteImageUrl(ref.src);
    const key = remoteUrl || ref.src;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ alt: ref.alt, remoteUrl, sourceUrl: source.normalizedUrl ? `${source.normalizedUrl}#readme` : ref.src });
  }

  for (const file of [...fileIndex].sort((a, b) => fallbackImagePriority(a) - fallbackImagePriority(b) || a.path.localeCompare(b.path))) {
    if (candidates.length >= 18) break;
    if (fallbackImagePriority(file) >= 100 || file.size > DEMO_IMAGE_MAX_BYTES) continue;
    const key = file.path;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ alt: path.basename(file.path, path.extname(file.path)), localPath: path.join(source.rootDir, file.path), relPath: file.path });
  }

  const assets: AssetRecord[] = [];
  for (const candidate of candidates) {
    if (assets.length >= DEMO_IMAGE_LIMIT) break;
    if (candidate.localPath && candidate.relPath) {
      const info = await stat(candidate.localPath).catch(() => null);
      const ext = imageExtFromPath(candidate.relPath);
      if (!info || !ext || info.size > DEMO_IMAGE_MAX_BYTES) continue;
      const buffer = await readFile(candidate.localPath).catch(() => null);
      if (!buffer) continue;
      assets.push(await writeDemoAssetFromBuffer(slug, assets.length + 1, buffer, ext, candidate.alt || path.basename(candidate.relPath, ext), candidate.sourceUrl ?? githubBlobUrl(source, candidate.relPath)));
      continue;
    }

    if (candidate.remoteUrl) {
      const remote = await fetchRemoteDemoImage(candidate.remoteUrl);
      if (!remote) continue;
      assets.push(await writeDemoAssetFromBuffer(slug, assets.length + 1, remote.buffer, remote.ext, candidate.alt || `Remote demo ${assets.length + 1}`, candidate.sourceUrl ?? candidate.remoteUrl));
    }
  }

  return assets;
}

async function readTextSample(rootDir: string, fileIndex: FileIndexEntry[]) {
  const preferred = fileIndex
    .filter((file) => ["doc", "style", "template", "code", "config"].includes(file.kind))
    .filter((file) => file.size > 0 && file.size <= 260_000)
    .sort((a, b) => {
      const score = (file: FileIndexEntry) => {
        const lower = file.path.toLowerCase();
        if (lower === "skill.md") return -100;
        if (lower.startsWith("references/")) return -80;
        if (lower.startsWith("docs/")) return -60;
        if (lower === "readme.md") return -50;
        if (lower === "package.json") return -40;
        if (file.kind === "style") return -25;
        if (file.kind === "template") return -20;
        return 0;
      };
      return score(a) - score(b) || a.path.localeCompare(b.path);
    })
    .slice(0, 48);

  const chunks: string[] = [];
  for (const file of preferred) {
    try {
      const content = await readFile(path.join(rootDir, file.path), "utf8");
      chunks.push(`--- ${file.path} ---\n${content.slice(0, 9000)}`);
    } catch {}
  }
  return chunks.join("\n\n").slice(0, 220_000);
}

async function licenseFromFiles(rootDir: string, fileIndex: FileIndexEntry[]) {
  const licenseFile = fileIndex.find((file) => /^license(\.|$)|^copying(\.|$)/i.test(path.basename(file.path)));
  if (!licenseFile || licenseFile.size > 80_000) return undefined;
  const content = await readFile(path.join(rootDir, licenseFile.path), "utf8").catch(() => "");
  if (/MIT License/i.test(content)) return "MIT";
  if (/Apache License/i.test(content)) return "Apache-2.0";
  if (/GNU GENERAL PUBLIC LICENSE|GPL/i.test(content)) return "GPL";
  if (/BSD 3-Clause/i.test(content)) return "BSD-3-Clause";
  if (/BSD 2-Clause/i.test(content)) return "BSD-2-Clause";
  return compactText(content.split(/\r?\n/).find(Boolean), 80) || undefined;
}

function defaultBestFor(packageType: DesignSystemPackageType) {
  if (packageType === "component-system") return ["B 端 dashboard", "数据表格", "表单工作流", "后台导航", "状态与反馈组件"];
  if (packageType === "presentation-system") return ["网页演示稿", "发布会 deck", "杂志风页面", "横向翻页 HTML slides"];
  if (packageType === "agent-skill-package") return ["已有 agent 工作流复用", "模板化生成任务", "带 references/assets 的可执行流程"];
  return ["品牌风格迁移", "视觉语言参考", "主题和版式抽象"];
}

function defaultNotFor(packageType: DesignSystemPackageType) {
  if (packageType === "component-system") return ["强叙事营销页", "需要完全自定义视觉系统的品牌站", "不允许引入第三方 CSS 的项目"];
  if (packageType === "presentation-system") return ["密集数据后台", "复杂表单系统", "需要原生 PPTX 协作编辑的流程"];
  if (packageType === "agent-skill-package") return ["没有明确触发任务的泛用 UI", "需要法律审查的商用资产迁移"];
  return ["严肃组件库替代", "需要完整交互状态的生产组件系统"];
}

function detectProject(source: MaterializedSource, fileIndex: FileIndexEntry[], textSample: string): ProjectDetection {
  const packageJson = source.packageJson;
  const pathCorpus = fileIndex.map((file) => file.path).join("\n").toLowerCase();
  const textCorpus = `${textSample}\n${packageJson?.name ?? ""}\n${packageJson?.description ?? ""}\n${packageJson?.keywords?.join(" ") ?? ""}`.toLowerCase();
  const hasRootSkill = fileIndex.some((file) => file.path.toLowerCase() === "skill.md");
  const hasReferences = fileIndex.some((file) => file.path.toLowerCase().startsWith("references/"));
  const hasAssets = fileIndex.some((file) => file.path.toLowerCase().startsWith("assets/"));
  const presentationSignal = /(ppt|slide|slides|deck|presentation|open-slide|horizontal|swipe|magazine|editorial|template\.html|theme|layout)/i.test(`${pathCorpus}\n${textCorpus}`);
  const componentSignal = /(dashboard|admin|ui kit|component|components|bootstrap|tailwind|scss|sass|css|button|card|table|form|modal|navbar|sidebar|badge)/i.test(`${pathCorpus}\n${textCorpus}`);
  const hasPackage = Boolean(packageJson?.name);

  let packageType: DesignSystemPackageType = "visual-style-system";
  const secondaryTypes: DesignSystemPackageType[] = [];
  let confidence: ProjectDetection["confidence"] = "low";

  if (hasRootSkill && presentationSignal) {
    packageType = "presentation-system";
    secondaryTypes.push("agent-skill-package");
    confidence = "high";
  } else if (hasRootSkill) {
    packageType = "agent-skill-package";
    confidence = "high";
  } else if (hasPackage && componentSignal) {
    packageType = "component-system";
    confidence = "high";
  } else if (componentSignal && fileIndex.filter((file) => ["style", "template", "code"].includes(file.kind)).length >= 8) {
    packageType = "component-system";
    confidence = "medium";
  } else if (presentationSignal) {
    packageType = "presentation-system";
    confidence = "medium";
  }

  if (packageType !== "agent-skill-package" && hasRootSkill && !secondaryTypes.includes("agent-skill-package")) secondaryTypes.push("agent-skill-package");
  if (packageType !== "component-system" && componentSignal && hasPackage) secondaryTypes.push("component-system");

  const repoName = source.normalizedUrl?.split("/").filter(Boolean).pop()?.replace(/\.git$/, "");
  const name = packageJson?.name ?? repoName ?? source.packageName ?? "Imported design system";
  const slugBase = slugify(name);
  const summary =
    packageJson?.description ||
    (packageType === "component-system"
      ? `${name} looks like a reusable UI/component system with local styles, components, or templates.`
      : packageType === "presentation-system"
        ? `${name} looks like a presentation or slide design workflow with reusable layouts and themes.`
        : packageType === "agent-skill-package"
          ? `${name} includes an agent skill entrypoint and reusable references/assets.`
          : `${name} was imported as a visual style system with low-confidence structure detection.`);

  const riskNotes = [
    source.license || packageJson?.license ? "" : "No clear license was detected; review usage rights before commercial reuse.",
    source.kind === "project-url" ? "Generic project URLs are not fully supported in the MVP; prefer GitHub, npm, or zip sources." : "",
    packageType === "component-system" ? "Component systems may ship global CSS. Verify style isolation before mixing with an existing app." : "",
    confidence === "low" ? "Detection confidence is low. Review generated capabilities before giving this skill authority in production tasks." : "",
  ].filter(Boolean);

  return {
    name,
    slugBase,
    packageType,
    secondaryTypes: [...new Set(secondaryTypes)],
    confidence,
    summary,
    bestFor: defaultBestFor(packageType),
    notFor: defaultNotFor(packageType),
    riskNotes,
    hasRootSkill,
    hasReferences,
    hasAssets,
  };
}

type CapabilityTemplate = {
  id: string;
  label: string;
  category: DesignSystemCapabilityCategory;
  description: string;
  usage: string;
  pattern: RegExp;
};

const COMPONENT_CAPABILITIES: CapabilityTemplate[] = [
  { id: "dashboard-shell", label: "Dashboard shell", category: "layout", description: "后台外壳、页面骨架、主内容区和导航组合。", usage: "搭建 B 端看板或管理台时先查这个能力。", pattern: /(dashboard|admin|layout|shell|page-wrapper|page body|page-header|app shell)/i },
  { id: "sidebar-navigation", label: "Sidebar navigation", category: "component", description: "侧边栏、垂直导航或后台菜单。", usage: "需要多级导航、模块切换或后台信息架构时使用。", pattern: /(sidebar|sidenav|side-nav|vertical nav|navigation)/i },
  { id: "top-navbar", label: "Top navbar", category: "component", description: "顶部导航、工具栏和 header。", usage: "需要全局导航、用户菜单、搜索或顶部操作区时使用。", pattern: /(navbar|topbar|header|toolbar)/i },
  { id: "metric-card", label: "Metric card", category: "component", description: "指标卡、统计卡和摘要面板。", usage: "展示 KPI、收入、用户数、趋势摘要时使用。", pattern: /(card|stats|statistic|metric|counter|widget)/i },
  { id: "data-table", label: "Data table", category: "component", description: "数据表格、列表行、排序、分页或 data grid。", usage: "管理台中展示可扫描、可比较的数据集合时使用。", pattern: /(table|datatable|data grid|data-grid|list row|pagination)/i },
  { id: "filter-toolbar", label: "Filter toolbar", category: "pattern", description: "筛选栏、搜索框、分段控件和批量操作工具条。", usage: "列表页需要组合搜索、筛选、排序和批量操作时使用。", pattern: /(filter|search|toolbar|segmented|select|dropdown)/i },
  { id: "form-layout", label: "Form layout", category: "component", description: "表单、输入控件、校验状态和设置页布局。", usage: "创建编辑页、设置页、登录页或工作流表单时使用。", pattern: /(form|input|select|textarea|checkbox|radio|validation|fieldset)/i },
  { id: "status-badge", label: "Status badge", category: "component", description: "badge、alert、toast、状态颜色和反馈组件。", usage: "表达状态、等级、标签、成功/失败/警告反馈时使用。", pattern: /(badge|status|alert|toast|notification|progress)/i },
  { id: "modal-dialog", label: "Modal and dialog", category: "component", description: "modal、dialog、popover、tooltip、offcanvas。", usage: "需要确认、详情、浮层表单或上下文提示时使用。", pattern: /(modal|dialog|popover|tooltip|offcanvas|drawer)/i },
  { id: "tabs", label: "Tabs", category: "component", description: "tabs、navs、分段页面切换和状态切换。", usage: "同一对象下切换详情、设置、活动记录等视图时使用。", pattern: /(tabs|tablist|navs|segmented)/i },
  { id: "charting", label: "Charting", category: "component", description: "图表、地图、可视化或 dashboard chart。", usage: "看板需要趋势、分布、地理或业务指标图形时使用。", pattern: /(chart|apexcharts|sparkline|map|visualization|graph)/i },
  { id: "design-tokens", label: "Design tokens", category: "token", description: "颜色、SCSS 变量、主题和基础视觉 token。", usage: "接入项目时先读取 token，避免凭空改色。", pattern: /(color|theme|token|variable|scss|sass|css var|--tblr)/i },
];

const PRESENTATION_CAPABILITIES: CapabilityTemplate[] = [
  { id: "horizontal-swipe-deck", label: "Horizontal swipe deck", category: "workflow", description: "横向翻页或网页演示稿结构。", usage: "生成浏览器可打开的演示稿或发布会 deck 时使用。", pattern: /(horizontal|swipe|deck|presentation|ppt|slides?)/i },
  { id: "magazine-layout", label: "Magazine layout", category: "layout", description: "杂志风、编辑式、封面和高密度视觉排版。", usage: "需要强审美页面而非普通卡片时使用。", pattern: /(magazine|editorial|zine|layout|grid|monocle|e-ink)/i },
  { id: "hero-slide", label: "Hero slide", category: "layout", description: "封面、开场页和视觉峰值页。", usage: "做演示稿开场、章节开头、品牌声明页时使用。", pattern: /(hero|cover|opening|title slide|封面|开场)/i },
  { id: "chapter-divider", label: "Chapter divider", category: "layout", description: "章节分隔、幕间页和节奏转换页。", usage: "长 deck 中需要切换主题和节奏时使用。", pattern: /(chapter|section divider|divider|章节|转场)/i },
  { id: "data-poster", label: "Data poster", category: "pattern", description: "大数字、数据海报和指标故事页。", usage: "把关键数据做成强视觉表达时使用。", pattern: /(data|stat|number|poster|metric|数字)/i },
  { id: "image-grid", label: "Image grid", category: "layout", description: "图片网格、多图拼贴和视觉证据页。", usage: "展示截图、素材、案例矩阵时使用。", pattern: /(image grid|gallery|masonry|photo|图片|图像)/i },
  { id: "pipeline-slide", label: "Pipeline slide", category: "pattern", description: "流程、阶段、路线和步骤页。", usage: "解释方法论、路线图、工作流时使用。", pattern: /(pipeline|process|timeline|workflow|step|流程)/i },
  { id: "before-after-slide", label: "Before / after slide", category: "pattern", description: "前后对比、反模式和改造结果页。", usage: "说明错误抽象和正确迁移方向时使用。", pattern: /(before|after|anti-pattern|compare|comparison|对比)/i },
  { id: "editorial-theme", label: "Editorial theme", category: "token", description: "主题、字体、颜色和杂志式视觉约束。", usage: "生成 deck 前先读取主题规则，保持视觉一致。", pattern: /(theme|typography|font|palette|color|主题|字体)/i },
  { id: "single-file-html-deck", label: "Single-file HTML deck", category: "adapter", description: "单文件 HTML 演示稿输出方式。", usage: "需要可直接分发、预览或嵌入的 HTML deck 时使用。", pattern: /(single[- ]file|template\.html|html|browser|standalone|单文件)/i },
];

const SKILL_CAPABILITIES: CapabilityTemplate[] = [
  { id: "agent-skill-workflow", label: "Agent skill workflow", category: "workflow", description: "已有 SKILL.md 所定义的触发规则和执行流程。", usage: "agent 需要直接复用上游工作流时先读取 wrapper skill。", pattern: /(skill\.md|workflow|use when|trigger|agent|codex|claude)/i },
  { id: "bundled-references", label: "Bundled references", category: "asset", description: "references 文档、模板和上下文材料。", usage: "需要精确遵守上游规则时读取对应 reference 文件。", pattern: /(references\/|reference|components\.md|layouts\.md|themes\.md)/i },
  { id: "quality-checklist", label: "Quality checklist", category: "workflow", description: "生成前后的检查清单和验收规则。", usage: "交付前验证视觉、布局和产物完整性。", pattern: /(checklist|quality|validate|验收|检查)/i },
];

function evidenceFor(template: CapabilityTemplate, fileIndex: FileIndexEntry[], textSample: string) {
  const matchingPaths = fileIndex
    .filter((file) => template.pattern.test(file.path))
    .map((file) => file.path)
    .slice(0, 8);
  const textEvidence = template.pattern.test(textSample) ? [`Text evidence matched ${template.id}.`] : [];
  return { matchingPaths, evidence: [...textEvidence, ...matchingPaths.map((item) => `File path: ${item}`)].slice(0, 8) };
}

function buildCapabilities(detection: ProjectDetection, fileIndex: FileIndexEntry[], textSample: string): DesignSystemCapability[] {
  const templates = [
    ...(detection.packageType === "presentation-system" ? PRESENTATION_CAPABILITIES : []),
    ...(detection.packageType === "component-system" ? COMPONENT_CAPABILITIES : []),
    ...(detection.hasRootSkill ? SKILL_CAPABILITIES : []),
    ...(detection.packageType === "visual-style-system" ? [COMPONENT_CAPABILITIES[11], PRESENTATION_CAPABILITIES[8]] : []),
  ];
  const capabilities: DesignSystemCapability[] = [];

  for (const template of templates) {
    const { matchingPaths, evidence } = evidenceFor(template, fileIndex, textSample);
    const shouldInclude = evidence.length > 0 || (detection.packageType === "component-system" && ["dashboard-shell", "metric-card", "data-table", "form-layout", "design-tokens"].includes(template.id)) || (detection.packageType === "presentation-system" && ["horizontal-swipe-deck", "magazine-layout", "hero-slide", "editorial-theme", "single-file-html-deck"].includes(template.id));
    if (!shouldInclude) continue;
    capabilities.push({
      id: template.id,
      label: template.label,
      category: template.category,
      description: template.description,
      usage: template.usage,
      evidence: evidence.length ? evidence : ["Included as a default capability for this package type; verify against the vendor snapshot."],
      sourcePaths: matchingPaths,
    });
  }

  if (capabilities.length === 0) {
    capabilities.push({
      id: "visual-style-reference",
      label: "Visual style reference",
      category: "token",
      description: "低置信度视觉风格参考，可用于主题、配色和版式启发。",
      usage: "只作为设计参考使用，不要把它当成完整组件系统。",
      evidence: ["Fallback capability generated because no strong component/workflow signals were detected."],
      sourcePaths: fileIndex.slice(0, 8).map((file) => file.path),
    });
  }

  return [...new Map(capabilities.map((item) => [item.id, item])).values()].slice(0, 18);
}

function cleanHex(hex: string) {
  const value = hex.trim().replace(/;$/, "").toLowerCase();
  if (!/^#([0-9a-f]{3,8})$/i.test(value)) return null;
  if (value.length === 4) return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  if (value.length === 7) return value;
  if (value.length === 9) return value.slice(0, 7);
  return null;
}

function buildProjectTokens(textSample: string, packageType: DesignSystemPackageType): DesignTokens {
  const counts = new Map<string, number>();
  for (const match of textSample.matchAll(/#(?:[0-9a-fA-F]{3,8})\b/g)) {
    const hex = cleanHex(match[0]);
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const colors = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
  const primary = colors[0] ?? (packageType === "presentation-system" ? "#111827" : "#206bc4");
  const secondary = colors.find((value) => value !== primary) ?? (packageType === "presentation-system" ? "#d4af37" : "#6b7280");
  const surface = colors.find((value) => value === "#ffffff" || value === "#f8fafc" || value === "#f9fafb") ?? "#ffffff";
  const text = colors.find((value) => value === "#000000" || value === "#111827" || value === "#1f2937") ?? "#111827";
  const fontMatches = [...textSample.matchAll(/font-family\s*:\s*([^;}{]+)/gi)]
    .map((match) => match[1].split(",")[0].trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  const primaryFont = fontMatches[0] ?? "Inter";
  const displayFont = fontMatches.find((font) => /display|serif|grotesk|mechanik|georgia|mono/i.test(font)) ?? primaryFont;
  const monoFont = fontMatches.find((font) => /mono|code|menlo|jetbrains/i.test(font)) ?? "JetBrains Mono";

  return {
    colors: {
      primary,
      secondary,
      success: colors.find((value) => /#(?:0|1|2|3|4|5|6|7|8|9|a|b|c|d|e|f){6}/i.test(value)) ?? secondary,
      warning: "#f59f00",
      danger: "#d63939",
      surface,
      text,
      neutral: "#f3f4f6",
    },
    typography: {
      scale: ["12", "14", "16", "20", "24", "32", "40"],
      families: { primary: primaryFont, display: displayFont, mono: monoFont },
      weights: ["400", "500", "600", "700"],
    },
    spacing: {
      baseline: "8px baseline grid",
      layout: packageType === "component-system" ? "Dense but predictable operational spacing for repeated dashboard work." : "Editorial rhythm with strong section contrast and reusable layout primitives.",
    },
    motion: {
      transition: "150-250ms",
      easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      notes: ["Use source-system states first; only add decorative motion when the package documents it."],
    },
  };
}

function buildProjectEvidence(source: MaterializedSource, detection: ProjectDetection, fileIndex: FileIndexEntry[], capabilities: DesignSystemCapability[], tokens: DesignTokens, textSample: string, assets: AssetRecord[]): DesignEvidence {
  const indexedDocs = fileIndex.filter((file) => file.kind === "doc").length;
  const indexedStyles = fileIndex.filter((file) => file.kind === "style").length;
  const indexedCode = fileIndex.filter((file) => file.kind === "code").length;
  const indexedImages = fileIndex.filter((file) => [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(file.ext)).length;
  const indexedSvgs = fileIndex.filter((file) => file.ext === ".svg").length;
  return {
    title: detection.name,
    sourceUrl: source.normalizedUrl ?? source.packageName ?? source.input,
    sourceHost: source.host ?? (source.kind === "npm-package" ? "npm" : "local-source"),
    sourceMode: "design-system-project",
    description: detection.summary,
    headings: [detection.name, ...capabilities.slice(0, 4).map((item) => item.label)],
    buttonLabels: [],
    linkLabels: [],
    colorCandidates: Object.values(tokens.colors).map((value) => ({ value, count: 1 })),
    fontCandidates: Object.values(tokens.typography.families),
    domSignals: {
      headingCount: indexedDocs,
      sectionCount: fileIndex.length,
      buttonCount: 0,
      linkCount: 0,
      imageCount: indexedImages + indexedSvgs,
      formCount: capabilities.some((item) => item.id === "form-layout") ? 1 : 0,
      navCount: capabilities.some((item) => item.id.includes("nav") || item.id.includes("sidebar")) ? 1 : 0,
      cardLikeCount: capabilities.some((item) => item.id === "metric-card") ? 1 : 0,
    },
    interactionSignals: {
      hasHoverStyles: /:hover/.test(textSample),
      hasAnimations: /@keyframes|animation\s*:/.test(textSample),
      hasTransitions: /transition\s*:/.test(textSample),
      hasStickyElements: /position\s*:\s*sticky/.test(textSample),
      hasScrollSnap: /scroll-snap/.test(textSample),
      hasForms: capabilities.some((item) => item.id === "form-layout"),
    },
    assetSummary: {
      total: fileIndex.filter((file) => file.kind === "asset").length,
      icons: fileIndex.filter((file) => file.ext === ".ico").length,
      images: indexedImages,
      logos: fileIndex.filter((file) => /logo/i.test(file.path)).length,
      svgs: indexedSvgs,
      videos: fileIndex.filter((file) => /\.(mp4|webm|mov)$/i.test(file.path)).length,
    },
    sections: capabilities.slice(0, 12).map((capability, index) => ({
      id: `capability-${capability.id}`,
      order: index + 1,
      tag: "capability",
      selector: capability.sourcePaths[0] ?? capability.id,
      role: "content",
      label: capability.label,
      headings: [capability.label],
      textSample: capability.description,
      ctas: [],
      links: [],
      assetRefs: capability.sourcePaths,
      componentHints: [capability.category, capability.id],
      interactionHints: [capability.usage],
    })),
    notes: [
      `Project source was classified as ${detection.packageType}.`,
      `Indexed ${fileIndex.length} files (${indexedDocs} docs, ${indexedStyles} style files, ${indexedCode} code files).`,
      assets.length ? `Localized ${assets.length} README/demo preview images for cards and preview surfaces.` : "No README/demo preview image was localized; UI falls back to generated structural previews.",
      detection.hasRootSkill ? "A root SKILL.md was detected and wrapped rather than overwritten." : "No root SKILL.md was detected; Design Vault generated a wrapper skill from the project evidence.",
      "License detection is informational only and should be reviewed by a human before commercial reuse.",
    ],
  };
}

function deriveThemeSurface(themes: ParsedThemeMarkdownBlock[] | undefined, varName: string): string | undefined {
  if (!themes?.length) return undefined;
  for (const theme of themes) {
    const value = theme.variables[varName];
    if (value && isValidHex(value)) return value;
  }
  return undefined;
}

function buildThemeAccentPalette(themes: ParsedThemeMarkdownBlock[], themeSources: Array<{ relativePath: string }>) {
  const palette: NonNullable<DesignSystemProfile["colorRoles"]["accentPalette"]> = [];
  const total = themes.length;

  for (let i = 0; i < themes.length; i++) {
    const theme = themes[i];
    const vars = theme.variables;
    const source = themeSources[i];
    // Prefer --accent (Swiss style) over --ink (magazine style)
    const hasAccent = vars["accent"] && isValidHex(vars["accent"]);
    const hex = hasAccent ? vars["accent"] : vars["ink"] && isValidHex(vars["ink"]) ? vars["ink"] : undefined;
    if (!hex) continue;
    palette.push({
      hex,
      role: theme.themeName,
      canonicalRole: hasAccent ? "accent" : "hero",
      coverage: `主题色板 ${i + 1} / ${total}`,
      evidence: `${source.relativePath} ## ${theme.themeName}`,
    });
  }
  return palette;
}

/**
 * W8.1: synthesise the visualDna block from REAL evidence rather than
 * heuristic stub strings. Earlier versions emitted sentences like
 * "Imported font candidates include primary var(--sans)..." which the
 * downstream card LLM rendered verbatim onto the style card. We now:
 *
 *   - When parsedThemes exist: write one-line evidence-grounded prose
 *     that names the actual theme palette (e.g. "5-theme magazine
 *     system anchored on Monocle Classic ink #0a0a0b on warm paper
 *     #efe7d2; companion themes Indigo Porcelain, Forest Ink…").
 *   - When parsedThemes are absent: emit the empty string so the
 *     downstream renderer relies on colorRoles / typographyRoles
 *     directly instead of parroting a placeholder.
 *   - For sibling output, when styleMeta is supplied, prefix the
 *     prose with the style name so a reader of the rendered card
 *     can tell which sibling it is from the visualThesis alone.
 */
function buildVisualDna(
  detection: ProjectDetection,
  capabilities: DesignSystemCapability[],
  tokens: DesignTokens,
  parsedThemes: { themes: ParsedThemeMarkdownBlock[]; sources: Array<{ relativePath: string }> } | undefined,
  styleMeta: { styleId: string; styleName: string; sourceFile: string } | undefined,
  topCapabilities: DesignSystemCapability[],
): DesignSystemProfile["visualDna"] {
  const themes = parsedThemes?.themes ?? [];
  const themeCount = themes.length;
  const stylePrefix = styleMeta ? `${styleMeta.styleName} · ` : "";

  let colorAtmosphere = "";
  if (themeCount > 0) {
    const anchorTheme = themes[0];
    const anchorInk = anchorTheme.variables["ink"];
    const anchorPaper = anchorTheme.variables["paper"];
    const anchorAccent = anchorTheme.variables["accent"];
    const others = themes.slice(1, 4).map((t) => t.themeName);
    const anchorParts: string[] = [];
    if (anchorAccent && isValidHex(anchorAccent)) anchorParts.push(`accent ${anchorAccent}`);
    if (anchorInk && isValidHex(anchorInk)) anchorParts.push(`ink ${anchorInk}`);
    if (anchorPaper && isValidHex(anchorPaper)) anchorParts.push(`paper ${anchorPaper}`);
    const anchor = anchorParts.length ? ` anchored on ${anchorParts.join(" / ")}` : "";
    const companions = others.length ? `; companion themes ${others.join(", ")}` : "";
    colorAtmosphere = `${stylePrefix}${themeCount}-theme palette${anchor}${companions}.`;
  }

  let typographySignal = "";
  // Only emit a typography sentence when we actually have a real font
  // family. Don't echo the `var(--sans)` heuristic — that gets caught
  // by sanitizeFontFamily downstream and replaced with Inter, but
  // emitting it here would still leak into card prompts.
  const display = tokens.typography.families.display;
  const body = tokens.typography.families.primary;
  const realDisplay = display && !/^var\(/.test(display);
  const realBody = body && !/^var\(/.test(body);
  if (realDisplay || realBody) {
    const named = [realDisplay ? `display ${display}` : "", realBody && body !== display ? `body ${body}` : ""].filter(Boolean).join(" + ");
    if (named) typographySignal = `${stylePrefix}Typography uses ${named}.`;
  }

  const layoutGrammar = topCapabilities.length
    ? `${stylePrefix}Layout grammar carried by ${topCapabilities.map((c) => c.id).join(", ")}.`
    : "";

  const componentLanguage = topCapabilities.length
    ? topCapabilities.map((c) => c.label).join(", ")
    : "";

  return {
    colorAtmosphere,
    typographySignal,
    layoutGrammar,
    componentLanguage,
    motionCharacter: tokens.motion.notes.join(" "),
    mustPreserve: [
      "Generated wrapper skill entrypoint",
      "Local vendor snapshot path",
      ...(styleMeta ? [`Style identity: ${styleMeta.styleName}`] : []),
      ...topCapabilities.map((c) => c.label),
    ],
  };
}

/**
 * W8.1 thesis builder. The previous visualThesis was a generic
 * boilerplate sentence ("This package should be treated as source
 * evidence first..."). The card LLM ignored or paraphrased it, which
 * gave the user no information about which sibling they were looking
 * at. Now: when we know the style identity, the thesis names the
 * style + anchor theme so the card has a concrete identity to work
 * with.
 */
function buildVisualThesis(
  detection: ProjectDetection,
  parsedThemes: { themes: ParsedThemeMarkdownBlock[]; sources: Array<{ relativePath: string }> } | undefined,
  styleMeta: { styleId: string; styleName: string; sourceFile: string } | undefined,
): string {
  const themes = parsedThemes?.themes ?? [];
  if (styleMeta && themes.length > 0) {
    const anchor = themes[0];
    const themeNames = themes.slice(0, 4).map((t) => t.themeName).join(", ");
    const more = themes.length > 4 ? `, +${themes.length - 4} more` : "";
    return `${styleMeta.styleName}: a ${themes.length}-theme visual system within ${detection.name}. Anchor palette ${anchor.themeName}. Companion themes: ${themeNames}${more}.`;
  }
  if (themes.length > 0) {
    const themeNames = themes.slice(0, 6).map((t) => t.themeName).join(", ");
    return `${detection.name} ships a ${themes.length}-theme palette set: ${themeNames}.`;
  }
  return `${detection.name} — ${detection.summary}`;
}

function buildProjectProfile(
  detection: ProjectDetection,
  capabilities: DesignSystemCapability[],
  tokens: DesignTokens,
  source: MaterializedSource,
  parsedThemes?: { themes: ParsedThemeMarkdownBlock[]; sources: Array<{ relativePath: string }> },
  styleMeta?: { styleId: string; styleName: string; sourceFile: string },
  resolvedTypography?: ResolvedFontStack,
  parsedLayouts?: ParsedLayoutBlock[],
  parsedAntiPatterns?: string[],
  parsedRhythm?: ParsedRhythm,
  parsedComponents?: ParsedComponentBlock[],
  parsedGridPresets?: ParsedGridPreset[],
): DesignSystemProfile {
  const componentSystem = detection.packageType === "component-system";
  const presentationSystem = detection.packageType === "presentation-system";
  const skillPackage = detection.packageType === "agent-skill-package" || detection.secondaryTypes.includes("agent-skill-package");
  const packageLabel = presentationSystem ? "presentation design system" : componentSystem ? "component design system" : skillPackage ? "agent skill package" : "visual style system";
  const topCapabilities = capabilities.slice(0, 5);

  return {
    schemaVersion: "2.0",
    systemName: detection.name,
    archetype: packageLabel,
    confidence: detection.confidence,
    visualThesis: buildVisualThesis(detection, parsedThemes, styleMeta),
    summary: detection.summary,
    methodology: {
      sourceOfTruth: [
        "Root metadata such as package.json, README, LICENSE, and SKILL.md.",
        "Selected vendor snapshot under the local Design Vault record.",
        "Generated capabilities mapped from file paths and source text signals.",
      ],
      abstractionSteps: [
        "Classify the imported project only as a routing label, not as permission to apply a fixed visual template.",
        "Use semantic capabilities rather than raw file names when matching user requests.",
        "Read the wrapper skill first, then load only the needed reference file and source assets.",
        "Separate documented source facts from inferred design roles before generating previews or downstream artifacts.",
      ],
      fidelityChecks: [
        "The generated output should use package capabilities only when the user request matches their documented intent.",
        "Do not silently mix global CSS frameworks into existing projects without checking integration risk.",
        "Do not invent visual grammar from package type alone; require README/demo/source assets or mark confidence low.",
        "Review license and confidence notes before commercial reuse.",
      ],
    },
    visualDna: buildVisualDna(detection, capabilities, tokens, parsedThemes, styleMeta, topCapabilities),
    previewStrategy: {
      renderer: "custom",
      rationale: "Project imports should preview localized source evidence and documented capabilities, not a visual stereotype inferred from package type.",
      layoutDirectives: [
        "Use README/demo images or localized assets first when available.",
        "If no visual assets exist, show a neutral capability specimen with clear low-confidence framing.",
        ...detection.bestFor,
      ],
      avoidDirectives: [
        "Do not infer a dashboard, deck, or brand look from package type alone.",
        "Do not replace source assets with a generic Design Vault card.",
        ...detection.notFor,
      ],
    },
    colorRoles: {
      brandPrimary: tokens.colors.primary,
      brandSecondary: tokens.colors.secondary,
      background: tokens.colors.surface,
      text: tokens.colors.text,
      surfaceAlternate: deriveThemeSurface(parsedThemes?.themes, "paper"),
      surfaceDeep: deriveThemeSurface(parsedThemes?.themes, "ink-tint") ?? deriveThemeSurface(parsedThemes?.themes, "ink"),
      accentPalette: parsedThemes ? buildThemeAccentPalette(parsedThemes.themes, parsedThemes.sources) : undefined,
      notes: [
        "Project import colors are evidence extracted from local files; verify against official docs before production use.",
        "Do not promote package-type assumptions into color roles; require source docs, CSS, screenshots, or localized assets.",
      ],
    },
    typographyRoles: {
      // W9.1: prefer resolved-from-template font stacks when present.
      // resolveTypographyFromTemplate returns real CSS font-family
      // chains (e.g. "Playfair Display, Source Serif 4, ..., Noto Serif
      // SC, ..." for magazine; "Inter, Helvetica Neue, ..." for swiss).
      // sanitizeFontFamily downstream still validates the strings — real
      // names pass; CSS var() fragments still get caught.
      display: resolvedTypography?.display || tokens.typography.families.display,
      body: resolvedTypography?.body || tokens.typography.families.primary,
      mono: resolvedTypography?.mono || tokens.typography.families.mono,
      rationale: resolvedTypography
        ? [
            `Typography resolved from upstream template (${resolvedTypography.source}). Google Fonts loaded: ${resolvedTypography.loadedFamilies?.join(", ") || "none"}.`,
            "Stacks include CJK + Latin so multi-script content renders correctly.",
          ]
        : ["Typography was inferred from source text and CSS signals.", "If the package ships font files or docs, read generated references before final implementation."],
    },
    spacingSystem: {
      base: tokens.spacing.baseline,
      density: "source-reference-driven",
      rhythmNotes: [tokens.spacing.layout, "Density should follow documented examples, README/demo assets, or matched capability references."],
    },
    compositionSignatures: [
      // O7: grid primitives go FIRST so the closed-option-set renderer
      // prompt sees them at the top of compositionSignatures. Each line
      // is `  .classname — ratio, gap, align-items` with a leader header
      // distinguishing them from existing meta entries.
      ...formatGridPresetSignatures(parsedGridPresets ?? []),
      `${detection.name} was imported as ${packageLabel}.`,
      `Best-fit capabilities: ${topCapabilities.map((item) => item.id).join(", ") || "review required"}.`,
      `Source kind: ${source.kind}; license: ${source.license ?? "unknown"}.`,
    ],
    componentSignatures: [
      // W9.4: parsed component catalog goes FIRST. Each entry carries
      // the real CSS class name set + role description so the AI
      // selects from documented components rather than inventing
      // new "data display panels" or "callout boxes".
      ...(parsedComponents ?? []).map((component) => ({
        name: component.name,
        role: component.role,
        traits: component.traits.length > 0
          ? component.traits.map((cls) => `.${cls}`)
          : ["(no class signature documented)"],
        states: component.states.length > 0 ? component.states : ["default"],
      })),
      ...topCapabilities.map((capability) => ({
        name: capability.label,
        role: capability.description,
        traits: [capability.usage, ...capability.evidence.slice(0, 2)],
        states: capability.category === "component" ? ["default", "hover", "focus-visible", "disabled"] : ["default"],
      })),
    ],
    componentMotionRecipes: [
      {
        id: "documented-state-feedback",
        component: topCapabilities.find((capability) => capability.category === "component")?.label ?? "Imported component",
        role: "documented or inferred component feedback",
        trigger: "hover/focus/state-change",
        statePair: "default -> interactive state",
        properties: ["opacity", "color", "border", "transform"],
        timing: { duration: tokens.motion.transition, easing: tokens.motion.easing },
        choreography: ["Use package-documented states first.", "Keep feedback local to the component surface."],
        cssHint: "Read source references for transition/animation declarations before implementing motion.",
        pptAdapter: ["Show documented component states as before/after or settled emphasis in previews.", "Do not invent animations beyond package evidence."],
        evidence: ["Generated from imported package capabilities and token motion notes."],
        confidence: /transition|animation|:hover|@keyframes/.test(tokens.motion.notes.join(" ")) ? "medium" : "low",
      },
    ],
    interactionModel: {
      character: "Use only documented or locally inferred states; package type alone is not interaction evidence.",
      states: ["default", "hover/focus when documented", "disabled/error when documented", "review-needed"],
      motionNotes: tokens.motion.notes,
    },
    voiceAndBrand: {
      tone: ["source-grounded", "capability-routed", "review-aware"],
      copyNotes: ["Generated skill text should describe package capabilities, not invent product marketing copy."],
    },
    accessibilityAndRisks: ["Generated components still need project-level accessibility verification.", ...detection.riskNotes],
    antiPatterns: [
      // W9.3: parsed checklist + lock rules go FIRST as severity-sorted
      // 三段式 strings. The renderer prompt treats every entry as a
      // HARD CONSTRAINT. Upstream-authored rules win over generic ones.
      ...(parsedAntiPatterns ?? []),
      "Do not treat a file index as proof of a production-ready component.",
      "Do not install global CSS into an existing app without checking framework conflicts.",
      "Do not auto-install this skill into global agent directories; Design Vault only generates the local package.",
      "Do not infer visual style from package type without source assets, README examples, or documented references.",
    ],
    evidenceSummary: [
      `Source: ${source.normalizedUrl ?? source.packageName ?? source.input}`,
      `Package type: ${detection.packageType}${detection.secondaryTypes.length ? ` + ${detection.secondaryTypes.join(", ")}` : ""}`,
      `Capabilities: ${capabilities.map((item) => item.id).join(", ")}`,
      `License: ${source.license ?? "unknown"}`,
    ],
    openSlideGuidance: {
      direction: "Use this package as source-grounded visual/component/workflow evidence when creating downstream slides.",
      coverApproach: "Start with localized README/demo assets or documented source examples; if absent, show the capability contract and mark visual confidence low.",
      layoutApproach: [
        "Match the user request to capabilities before choosing layout.",
        "Load source references that support the chosen capability.",
        "Keep package-type labels out of the visual style unless the source examples demonstrate them.",
      ],
      motionApproach: ["Use documented package motion only; otherwise keep motion minimal and mark it as inferred."],
    },
    presentationStyle: {
      narrativeArc: [
        "Start with localized source evidence or the strongest available package artifact.",
        "Show capability map and best-fit use cases.",
        "Separate documented facts from inferred roles.",
        "Close with the generated skill invocation and fidelity checklist.",
      ],
      themeRhythm: {
        paletteRule: "Use extracted tokens as package evidence; do not overfit them as final brand tokens.",
        // W9.3: parsed rhythm guidance from upstream layouts*.md takes
        // precedence over the generic fallback. lightDarkPattern is the
        // sequence template (e.g. ["Hero Cover", "Act Divider", "Big
        // Numbers", ...]); emphasisCadence carries hard rules + key
        // moment markers.
        lightDarkPattern: parsedRhythm?.pattern && parsedRhythm.pattern.length > 0
          ? parsedRhythm.pattern
          : ["source evidence", "capability map", "adapter/risk page", "checklist close"],
        emphasisCadence: parsedRhythm
          ? [...parsedRhythm.rules, ...parsedRhythm.cadence]
          : ["Every major section should map back to a concrete local file or generated capability."],
      },
      slideArchetypes: [
        // W9.2 + W9.5: parsed layouts from references/layouts*.md go
        // FIRST in the array so the closed-option-set AI prompt reads
        // them as the primary palette of compositions. The generic
        // presentation samples + capability fallbacks come AFTER —
        // only relevant when upstream didn't document layouts.
        ...(parsedLayouts ?? []).map((layout) => ({
          name: layout.name,
          use: layout.use ?? `Upstream-documented layout: ${layout.name}`,
          construction: layout.construction.length > 0 ? layout.construction : ["(no construction steps documented)"],
        })),
        ...((parsedLayouts && parsedLayouts.length > 0) ? [] : requiredPresentationSampleArchetypes()),
        { name: "Source evidence cover", use: "Introduce source, strongest local asset, type, and confidence.", construction: ["name", "source asset or evidence", "type label", "license", "confidence"] },
        { name: "Capability map", use: "Show semantic abilities an agent can call.", construction: ["capability id", "usage", "source paths"] },
        { name: "Fact vs inference page", use: "Prevent subjective style drift.", construction: ["documented facts", "inferred roles", "unknowns", "review actions"] },
        { name: "Adapter/risk page", use: "Clarify framework and license boundaries.", construction: ["runtime", "CSS risk", "manual install"] },
      ],
      typographyHierarchy: ["Use package docs if available; otherwise use Design Vault inferred roles."],
      imageRules: ["Prefer assets from the local vendor snapshot if they are relevant and licensed."],
      motionRecipes: ["Use documented package motion first; otherwise default to simple fade/rise.", "Apply componentMotionRecipes to preview state changes when evidence exists."],
      chromeAndMetadata: ["Show Design Vault source path and package version when presenting this system."],
      qualityChecks: ["Read skill/SKILL.md first.", "Use capabilities.json for matching.", "Check manifest risk notes before production use."],
    },
    synthesis: {
      mode: "heuristic",
      status: "heuristic-only",
      reason: "Project package classification and skill wrapper generated from local file heuristics.",
      promptVersion: PROJECT_PROMPT_VERSION,
      evidenceStats: {
        headings: topCapabilities.length,
        buttons: 0,
        links: 0,
        colors: Object.values(tokens.colors).length,
        fonts: Object.values(tokens.typography.families).length,
        sections: capabilities.length,
        behaviorSignals: 0,
        responsiveSignals: 0,
      },
    },
  };
}

function capabilityMarkdown(capabilities: DesignSystemCapability[]) {
  return capabilities
    .map(
      (item) => `## ${item.label}

- ID: \`${item.id}\`
- Category: ${item.category}
- Use when: ${item.usage}
- Description: ${item.description}
- Source paths: ${item.sourcePaths.length ? item.sourcePaths.map((sourcePath) => `\`${sourcePath}\``).join(", ") : "Review vendor snapshot manually."}
- Evidence: ${item.evidence.join(" / ")}
`,
    )
    .join("\n");
}

function buildAdaptersMarkdown(manifest: DesignSystemPackageManifest, capabilities: DesignSystemCapability[]) {
  const componentSystem = manifest.packageType === "component-system" || manifest.secondaryTypes.includes("component-system");
  const presentationSystem = manifest.packageType === "presentation-system";
  return `# Adapters

## Source

- Package: ${manifest.name}
- Type: ${manifest.packageType}${manifest.secondaryTypes.length ? ` + ${manifest.secondaryTypes.join(", ")}` : ""}
- Vendor snapshot: \`${manifest.local.vendorDir}/source\`

## HTML / CSS

${componentSystem ? "Prefer the package's documented CSS/SCSS entrypoints. Load only the minimum runtime needed for the requested component set." : "Use generated tokens and references as visual guidance. Do not assume a full CSS runtime exists."}

## React / Next.js

${componentSystem ? "Wrap imported HTML/CSS patterns in local React components and preserve the host app's routing/data boundaries. Avoid broad global CSS imports unless the user approves the tradeoff." : "Translate layouts into local React components only after reading the relevant reference file."}

## Tailwind

Do not blindly mix Tailwind utility styling with this package's global CSS. Either treat this package as the runtime source of truth or translate its roles into local Tailwind tokens.

## Presentation

${presentationSystem ? "Use the package as a deck grammar only where its source files or references document that grammar. Start from localized examples, then map capability evidence before creating new slides." : "For slides, present this package as source-grounded design evidence and call out integration risks."}

## Capability IDs

${capabilities.map((item) => `- \`${item.id}\`: ${item.usage}`).join("\n")}
`;
}

async function writeSkillPackage(slug: string, manifest: DesignSystemPackageManifest, capabilities: DesignSystemCapability[], tokens: DesignTokens, copiedFiles: FileIndexEntry[]) {
  const dir = skillDir(slug);
  const referencesDir = path.join(dir, "references");
  await mkdir(referencesDir, { recursive: true });
  const activeSourcePaths = await copyActiveSkillSourceSnapshot(slug, copiedFiles);

  await writeText(
    path.join(referencesDir, "catalog.md"),
    `# ${manifest.name} Catalog

${manifest.summary}

## Best For

${manifest.bestFor.map((item) => `- ${item}`).join("\n")}

## Not For

${manifest.notFor.map((item) => `- ${item}`).join("\n")}

## Source

- Input: ${manifest.source.input}
- Kind: ${manifest.source.kind}
- Version: ${manifest.source.version ?? "unknown"}
- License: ${manifest.source.license}
- Vendor snapshot: \`${manifest.local.vendorDir}/source\`
`,
  );
  await writeText(path.join(referencesDir, "components.md"), `# Capabilities\n\n${capabilityMarkdown(capabilities)}`);
  await writeText(
    path.join(referencesDir, "tokens.md"),
    `# Tokens

## Colors

${Object.entries(tokens.colors).map(([key, value]) => `- ${key}: \`${value}\``).join("\n")}

## Typography

- Primary: ${tokens.typography.families.primary}
- Display: ${tokens.typography.families.display}
- Mono: ${tokens.typography.families.mono}
- Scale: ${tokens.typography.scale.join(" / ")}

## Spacing

- Baseline: ${tokens.spacing.baseline}
- Layout: ${tokens.spacing.layout}
`,
  );
  await writeText(
    path.join(referencesDir, "patterns.md"),
    `# Patterns

## Package Type

${manifest.packageType}${manifest.secondaryTypes.length ? ` + ${manifest.secondaryTypes.join(", ")}` : ""}

## Best Fit

${manifest.bestFor.map((item) => `- ${item}`).join("\n")}

## Avoid

${manifest.notFor.map((item) => `- ${item}`).join("\n")}

## How To Choose

- Match the user's requested product surface to \`capabilities.json\` before reading detailed files.
- Load only the references needed for the chosen capability.
- If confidence is low, ask for human review before production implementation.
`,
  );
  await writeText(path.join(referencesDir, "adapters.md"), buildAdaptersMarkdown(manifest, capabilities));
  await writeText(
    path.join(referencesDir, "checklist.md"),
    `# Checklist

- Read this skill's SKILL.md before using the package.
- Confirm the request matches one of: ${manifest.capabilities.map((item) => `\`${item}\``).join(", ")}.
- Check license: ${manifest.source.license}.
- Check confidence: ${manifest.confidence}.
- Review risk notes:
${manifest.riskNotes.map((item) => `  - ${item}`).join("\n") || "  - No additional risk notes captured."}
- For component systems, verify CSS/runtime isolation.
- For presentation systems, preserve only documented theme rhythm before creating new layouts; mark missing evidence as review-needed.
`,
  );

  const skillMd = `---
name: ${manifest.skill.name}
description: Use this Design Vault generated design-system skill when building with or referencing ${manifest.name}; triggers include ${manifest.packageType}, ${manifest.capabilities.slice(0, 8).join(", ")}, dashboard components, presentation decks, imported design systems, and agent-readable local design packages.
---

# ${manifest.name}

Use this wrapper as the entrypoint for the locally imported Design Vault package. It points to a selected vendor snapshot, generated capability index, adapter guidance, quality checklist, and the upstream package materialized under \`source/\`.

## Required Workflow

1. Read \`${manifest.local.manifestPath}\` to confirm package type, confidence, license, and risk notes.
2. Read \`${manifest.local.productPath ?? "PRODUCT.md"}\`, \`${manifest.local.designSpecPath ?? "DESIGN.md"}\`, and \`${manifest.local.styleCardPath ?? "STYLE_CARD.html"}\` before building.
3. Read \`${manifest.local.capabilitiesPath}\` and choose the closest semantic capability before opening detailed references.
4. Audit the output against \`${manifest.local.antiPatternsPath ?? "anti-patterns.json"}\` and \`${manifest.local.qualityGatesPath ?? "quality-gates.json"}\`, then revise once.
5. If the package has an upstream skill, read \`${path.join(dir, "source/SKILL.md")}\`; use its local \`source/references\`, \`source/assets\`, and \`source/scripts\` paths when following upstream instructions.
6. Load generated Design Vault references under \`${referencesDir}\` only for routing, tokens, adapters, and quality gates.
7. Use files under \`${manifest.local.vendorDir}/source\` as archived source evidence, and files under \`${path.join(dir, "source")}\` as the active installed skill copy.
8. Do not auto-install or mutate global agent skill directories unless the user explicitly asks.

## References

- Upstream skill source: \`${path.join(dir, "source/SKILL.md")}\`
- Upstream references: \`${path.join(dir, "source/references")}\`
- Upstream assets: \`${path.join(dir, "source/assets")}\`
- Upstream scripts: \`${path.join(dir, "source/scripts")}\`
- Product context: \`${manifest.local.productPath ?? "PRODUCT.md"}\`
- Executable design contract: \`${manifest.local.designSpecPath ?? "DESIGN.md"}\`
- Visual style card: \`${manifest.local.styleCardPath ?? "STYLE_CARD.html"}\`
- Anti-patterns: \`${manifest.local.antiPatternsPath ?? "anti-patterns.json"}\`
- Quality gates: \`${manifest.local.qualityGatesPath ?? "quality-gates.json"}\`
- Catalog: \`${path.join(referencesDir, "catalog.md")}\`
- Components/capabilities: \`${path.join(referencesDir, "components.md")}\`
- Tokens: \`${path.join(referencesDir, "tokens.md")}\`
- Patterns: \`${path.join(referencesDir, "patterns.md")}\`
- Adapters: \`${path.join(referencesDir, "adapters.md")}\`
- Checklist: \`${path.join(referencesDir, "checklist.md")}\`

## Materialized Upstream Files

${activeSourcePaths.length ? activeSourcePaths.map((item) => `- \`${path.join(dir, item)}\``).join("\n") : "- No upstream source files were materialized into this active skill."}

## Invocation Rule

Use this package only when the user's requested surface matches one of these capabilities:

${capabilities.map((item) => `- \`${item.id}\`: ${item.usage}`).join("\n")}
`;

  await writeText(skillPath(slug), skillMd);
}

async function nextAvailableSlug(baseSlug: string) {
  let attempt = baseSlug || "design-system-project";
  let counter = 2;
  while (await pathExists(designDir(attempt))) {
    attempt = `${baseSlug}-${counter}`;
    counter += 1;
  }
  return attempt;
}

function sourceHost(source: MaterializedSource) {
  return source.host ?? (source.kind === "npm-package" ? "npm" : "project-source");
}

function createManifest(
  slug: string,
  source: MaterializedSource,
  detection: ProjectDetection,
  capabilities: DesignSystemCapability[],
  fetchedAt: string,
  copiedFiles: FileIndexEntry[],
): DesignSystemPackageManifest {
  const skillName = skillSafeName(`dv-${slug}`);
  const entrypoint = skillPath(slug);
  const referencePrompt = `请使用 Design Vault 生成的 ${detection.name} 设计系统 skill。先读取 ${entrypoint}，再读取 ${manifestPath(slug)} 和 ${capabilitiesPath(slug)}，按 capability 匹配组件/布局/演示需求，不要自动安装到全局目录。`;
  const manifest: DesignSystemPackageManifest = {
    schemaVersion: "1.0",
    id: slug,
    name: detection.name,
    packageType: detection.packageType,
    secondaryTypes: detection.secondaryTypes,
    confidence: detection.confidence,
    summary: detection.summary,
    bestFor: detection.bestFor,
    notFor: detection.notFor,
    capabilities: capabilities.map((item) => item.id),
    source: {
      input: source.input,
      kind: source.kind,
      normalizedUrl: source.normalizedUrl,
      host: sourceHost(source),
      packageName: source.packageName ?? source.packageJson?.name,
      repository: source.repository,
      version: source.version,
      commit: source.commit,
      license: source.license ?? "unknown",
      fetchedAt,
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
      referencePrompt,
      installCommand: `mkdir -p "\${CODEX_HOME:-$HOME/.codex}/skills" && cp -R "${skillDir(slug)}" "\${CODEX_HOME:-$HOME/.codex}/skills/${skillName}"`,
      references: activeSkillSourceReferencePaths(slug, copiedFiles),
    },
    riskNotes: detection.riskNotes,
  };
  return withManifestExecutionPaths(manifest);
}

function ensureProjectJob(job: IngestionJob) {
  if (job.mode !== "design-system-project") {
    throw new Error(`runProjectIngestion can only handle design-system-project jobs; received ${job.mode}.`);
  }
}

/**
 * W7/P4 sibling plan: take the grouped theme files and assign a unique
 * slug to each style. Filename-suffix-derived styleId is preferred
 * (`themes-swiss.md` → `swiss`). The PRIMARY (unsuffixed) file gets the
 * original base slug — if the base slug is already taken we'll fall
 * back to `<base>-primary`. Returns a list ordered the same way as
 * `themesByFile`, so the caller can substitute the already-reset slug
 * in place at position 0.
 */
async function planSiblingSlugs(
  baseSlug: string,
  themesByFile: Array<{
    relativePath: string;
    identity: ThemeFileStyleIdentity;
    themes: ParsedThemeMarkdownBlock[];
  }>,
): Promise<Array<{
  slug: string;
  styleId: string;
  styleName: string;
  sourceFile: string;
  themes: ParsedThemeMarkdownBlock[];
}>> {
  const plans: Array<{
    slug: string;
    styleId: string;
    styleName: string;
    sourceFile: string;
    themes: ParsedThemeMarkdownBlock[];
  }> = [];
  const usedSlugs = new Set<string>();
  for (const group of themesByFile) {
    const wanted = group.identity.styleId === "primary"
      ? baseSlug
      : `${baseSlug}-${group.identity.styleId}`;
    let attempt = wanted;
    let counter = 2;
    // Always pathExists-check: even the primary (unsuffixed) sibling
    // must not overwrite a pre-existing design at the base slug. The
    // caller substitutes the already-reset slug for position 0 AFTER
    // planning, so the just-reset dir is never the target here.
    while (usedSlugs.has(attempt) || (await pathExists(designDir(attempt)))) {
      attempt = `${wanted}-${counter}`;
      counter += 1;
    }
    usedSlugs.add(attempt);
    plans.push({
      slug: attempt,
      styleId: group.identity.styleId,
      styleName: group.identity.styleName,
      sourceFile: group.relativePath,
      themes: group.themes,
    });
  }
  return plans;
}

/**
 * Emit one complete design folder for a single style. Used by the
 * sibling-splitter path so each style ID in a multi-style skill produces
 * its own browsable design, profile, previews, and execution protocol.
 *
 * `isPrimaryReset` true means the caller already called `resetDesignDir`
 * and `copyVendorSnapshot` for this slug — we skip those steps to avoid
 * duplicate work. For subsequent siblings we re-do both because they're
 * fresh slugs.
 */
async function emitDesignOutput(params: {
  slug: string;
  isPrimaryReset: boolean;
  title: string;
  detection: ProjectDetection;
  capabilities: DesignSystemCapability[];
  tokens: DesignTokens;
  materialized: MaterializedSource;
  fileIndex: FileIndexEntry[];
  copiedFiles: FileIndexEntry[];
  manifest: DesignSystemPackageManifest;
  parsedThemes?: { themes: ParsedThemeMarkdownBlock[]; sources: Array<{ relativePath: string }> };
  textSample: string;
  job: IngestionJob;
  createdAt: string;
  styleMeta?: { styleId: string; styleName: string; sourceFile: string };
  siblings?: Array<{ slug: string; styleId: string; styleName: string }>;
}) {
  const {
    slug, isPrimaryReset, title, detection, capabilities, tokens, materialized,
    fileIndex, manifest, parsedThemes, textSample, job, createdAt, styleMeta, siblings,
  } = params;
  let { copiedFiles } = params;
  if (!isPrimaryReset) {
    await resetDesignDir(slug, "project-ingestion-sibling");
    copiedFiles = await copyVendorSnapshot(materialized.rootDir, vendorDir(slug), fileIndex);
  }

  // P3a + W6: extract W1.2 CSS evidence from vendor template HTML files.
  // For sibling designs we narrow template selection to the file
  // pattern matching the style (e.g. `swiss` style only ingests
  // `template-swiss.html`), so each sibling's tokens reflect the
  // style-specific motion/radius rules.
  // W9.1 moves template detection BEFORE buildProjectProfile so the
  // typography resolver can run on the effective template HTML and
  // feed the resolved font stacks into the profile from the start.
  const styleSuffix = styleMeta && styleMeta.styleId !== "primary" ? styleMeta.styleId : undefined;
  const templateHtmlFiles = fileIndex.filter((f) => {
    if (!/assets\/template[^/]*\.html$/i.test(f.path)) return false;
    if (!styleSuffix) return true;
    return new RegExp(`assets/template[^/]*-${styleSuffix}\\.html$`, "i").test(f.path)
      || new RegExp(`assets/template\\.html$`, "i").test(f.path) === false; // exclude unsuffixed when a suffix is present
  });
  let cssBundle = "";
  const seenLinked = new Set<string>();
  const filteredTemplates = styleSuffix
    ? templateHtmlFiles.filter((f) => new RegExp(`-${styleSuffix}\\.html$`, "i").test(f.path))
    : templateHtmlFiles.filter((f) => !/template-[a-z0-9][\w-]*\.html$/i.test(f.path));
  const effectiveTemplates = filteredTemplates.length > 0 ? filteredTemplates : templateHtmlFiles;

  // W9.1 typography resolver: read the FIRST effective template and
  // extract real font stacks. We use the first template — for siblings
  // this is the style-specific one; for non-sibling imports it's the
  // primary template.html. If the resolver returns null (no fonts
  // detectable), we fall back to the existing token-derived fonts.
  let resolvedTypography: ResolvedFontStack | undefined;
  if (effectiveTemplates.length > 0) {
    const firstTemplate = effectiveTemplates[0];
    const templateHtml = await readFile(path.join(materialized.rootDir, firstTemplate.path), "utf8").catch(() => "");
    if (templateHtml) {
      resolvedTypography = resolveTypographyFromTemplate(templateHtml) ?? undefined;
    }
  }

  // W9.2 layout catalog: parse references/layouts*.md (style-scoped
  // when sibling) for layout primitives with verbatim construction
  // steps. These feed into presentationStyle.slideArchetypes and drive
  // the AI renderer to "execute" upstream-documented compositions
  // instead of designing from scratch.
  let parsedLayouts: ParsedLayoutBlock[] | undefined;
  let parsedRhythm: ParsedRhythm | undefined;
  const layoutCandidates = fileIndex.filter((f) => /^references\/layouts[^/]*\.md$/i.test(f.path));
  const effectiveLayoutFile = styleSuffix
    ? layoutCandidates.find((f) => new RegExp(`-${styleSuffix}\\.md$`, "i").test(f.path))
    : layoutCandidates.find((f) => !/layouts-[a-z0-9][\w-]*\.md$/i.test(f.path)) ?? layoutCandidates[0];
  if (effectiveLayoutFile) {
    const layoutMd = await readFile(path.join(materialized.rootDir, effectiveLayoutFile.path), "utf8").catch(() => "");
    if (layoutMd) {
      const blocks = parseLayoutCatalog(layoutMd);
      if (blocks.length > 0) parsedLayouts = blocks;
      const rhythm = parseRhythmGuidance(layoutMd);
      if (rhythm) parsedRhythm = rhythm;
    }
  }

  // W9.3 anti-pattern parser: scan references for lock-rule and
  // checklist files; emit 三段式 strings into antiPatterns.
  // Style-scoped: when this is a sibling design, prefer style-specific
  // files (e.g. swiss-layout-lock.md only feeds the swiss sibling).
  let parsedAntiPatterns: string[] | undefined;
  const lockCandidates = fileIndex.filter((f) =>
    /^references\/.*(?:checklist|fidelity|lock|forbidden|rules|constraints)[^/]*\.md$/i.test(f.path),
  );
  const styleSpecificLocks = styleSuffix
    ? lockCandidates.filter((f) => new RegExp(`${styleSuffix}`, "i").test(f.path))
    : lockCandidates.filter((f) => !/(?:swiss|magazine|y2k|brutalist|editorial)[-_]/i.test(f.path));
  const effectiveLockFiles = styleSpecificLocks.length > 0 ? styleSpecificLocks : lockCandidates;
  const lockStrings: string[] = [];
  for (const lf of effectiveLockFiles.slice(0, 6)) {
    const md = await readFile(path.join(materialized.rootDir, lf.path), "utf8").catch(() => "");
    if (!md) continue;
    for (const rule of parseAntiPatternMarkdown(lf.path, md)) {
      lockStrings.push(formatAntiPatternRule(rule));
    }
  }
  if (lockStrings.length > 0) parsedAntiPatterns = lockStrings;

  // W9.4 component catalog: scan references/components*.md for upstream
  // component primitives with stable class names + traits + states.
  // Style-scoped via same suffix logic; falls back to unsuffixed when
  // no style-specific file exists.
  let parsedComponents: ParsedComponentBlock[] | undefined;
  const componentCandidates = fileIndex.filter((f) => /^references\/components[^/]*\.md$/i.test(f.path));
  // Prefer style-specific (components-<suffix>.md) but fall back to
  // unsuffixed components.md so siblings inherit shared base components
  // when they don't override.
  const baseComponentFile = componentCandidates.find((f) => !/components-[a-z0-9][\w-]*\.md$/i.test(f.path)) ?? componentCandidates[0];
  const effectiveComponentFile = styleSuffix
    ? (componentCandidates.find((f) => new RegExp(`-${styleSuffix}\\.md$`, "i").test(f.path)) ?? baseComponentFile)
    : baseComponentFile;
  if (effectiveComponentFile) {
    const md = await readFile(path.join(materialized.rootDir, effectiveComponentFile.path), "utf8").catch(() => "");
    if (md) {
      const blocks = parseComponentCatalog(md);
      if (blocks.length > 0) parsedComponents = blocks;
    }
  }

  // O7: cssBundle must be assembled BEFORE buildProjectProfile so the
  // grid-preset parser can feed parsedGridPresets into the profile's
  // compositionSignatures. Previously cssBundle was only used after
  // buildProjectProfile (radius/duration/easing/font-size-ratio go into
  // `evidence` post-profile). Moving the assembly up preserves that
  // downstream use AND unlocks pre-profile parsing.
  for (const tf of effectiveTemplates) {
    const html = await readFile(path.join(materialized.rootDir, tf.path), "utf8").catch(() => "");
    if (!html) continue;
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
    for (const block of styleBlocks) cssBundle += block[1] + "\n";
    const linkMatches = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi)];
    const templateDir = path.dirname(path.join(materialized.rootDir, tf.path));
    for (const linkTag of linkMatches) {
      const hrefMatch = linkTag[0].match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      if (/^https?:/i.test(href) || /^\/\//.test(href)) continue;
      const cssPath = path.resolve(templateDir, href);
      if (seenLinked.has(cssPath)) continue;
      seenLinked.add(cssPath);
      const cssText = await readFile(cssPath, "utf8").catch(() => "");
      if (cssText) cssBundle += cssText + "\n";
    }
  }

  // O7: grid-preset parser. Per AI-aesthetic-engineering methodology
  // §1.4 (传空间关系，不传定位指令), grid containers are FIXED VOCABULARY.
  // Each information relationship (主次 / 对等 / 矩阵) maps to one named
  // .grid-* class with predefined column ratios + gap + alignment. AI
  // must select from these classes; it must NOT write inline
  // grid-template-columns. parsedGridPresets[] surfaces into
  // compositionSignatures with a "GRID PRIMITIVES" header so the
  // closed-option-set renderer prompt picks them up.
  let parsedGridPresets: ParsedGridPreset[] | undefined;
  if (cssBundle.length > 0) {
    const presets = parseGridPresets(cssBundle);
    if (presets.length > 0) parsedGridPresets = presets;
  }

  const rawProfile = buildProjectProfile(detection, capabilities, tokens, materialized, parsedThemes, styleMeta, resolvedTypography, parsedLayouts, parsedAntiPatterns, parsedRhythm, parsedComponents, parsedGridPresets);
  const assets = await collectProjectPreviewAssets(slug, materialized, fileIndex);
  const evidence = buildProjectEvidence(materialized, detection, fileIndex, capabilities, tokens, textSample, assets);

  if (cssBundle.length > 0) {
    const radiusCandidates = extractRadiusCandidates(cssBundle);
    const durationCandidates = extractDurationCandidates(cssBundle);
    const easingCandidates = extractEasingCandidates(cssBundle);
    const fontSizeRatio = extractFontSizeRatio(cssBundle);
    if (radiusCandidates.length > 0) evidence.radiusCandidates = radiusCandidates;
    if (durationCandidates.length > 0) evidence.durationCandidates = durationCandidates;
    if (easingCandidates.length > 0) evidence.easingCandidates = easingCandidates;
    if (fontSizeRatio.sizesPx.length >= 3) evidence.fontSizeRatio = fontSizeRatio;
  }

  const profile = normalizeProfileForEmission(rawProfile, evidence);
  const sourceUrl = materialized.normalizedUrl ?? materialized.packageName ?? materialized.input;
  const meta: DesignMeta = withExecutionProtocolPaths({
    slug,
    title,
    sourceUrl,
    sourceHost: sourceHost(materialized),
    sourceMode: "design-system-project",
    sourceChain: [
      {
        role: "requested",
        url: sourceUrl,
        host: sourceHost(materialized),
        title,
        note: styleMeta
          ? `Design-system project (${styleMeta.styleName}) imported from ${materialized.kind}.`
          : `Design-system project imported from ${materialized.kind}.`,
      },
    ],
    status: "ready",
    summary: styleMeta ? `${detection.summary} (${styleMeta.styleName})` : detection.summary,
    tags: normalizeTags([
      packageTypeTag(detection.packageType),
      ...detection.secondaryTypes.map(packageTypeTag),
      ...(detection.hasRootSkill ? ["Skill 包"] : []),
      ...(styleMeta ? [styleMeta.styleId] : []),
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
  await writeSkillPackage(slug, manifest, capabilities, tokens, copiedFiles);
  await writeText(designDocPath(slug), buildDesignMd(profile, sourceHost(materialized), job.mode, evidence));
  await writeText(openSlideThemePath(slug), buildOpenSlideTheme(profile));
  await writeJson(tokensPath(slug), tokens);
  await writeJson(sourcePath(slug), {
    input: materialized.input,
    kind: materialized.kind,
    normalizedUrl: materialized.normalizedUrl,
    packageName: materialized.packageName ?? materialized.packageJson?.name,
    repository: materialized.repository,
    version: materialized.version,
    commit: materialized.commit,
    license: materialized.license ?? "unknown",
    fetchedAt: createdAt,
    indexedFiles: fileIndex,
    copiedFiles,
    previewAssets: assets,
    ...(styleMeta ? { styleMeta } : {}),
  });
  await writeJson(evidencePath(slug), evidence);
  await writeJson(profilePath(slug), profile);
  await writeText(previewPath(slug, "web"), renderWebPreview(meta));
  await writeText(previewPath(slug, "ppt"), pptDeckPreview.html);
  await writeText(previewPath(slug, "card"), cardPreview.html);
  await writeExecutionProtocol(meta, cardPreview.html);
  await writeRouterSkill(meta);

  // W7/P4 sibling cross-links: each multi-style design carries a
  // sibling.json pointing at the other style entries from the same
  // import, so the gallery + API can group them.
  if (siblings && siblings.length >= 2) {
    const otherSiblings = siblings.filter((s) => s.slug !== slug);
    await writeJson(path.join(designDir(slug), "sibling.json"), {
      schemaVersion: "1.0",
      role: "sibling",
      thisStyle: styleMeta ?? null,
      siblings: otherSiblings,
      parentBaseSlug: detection.slugBase || baseSlugFromSourceUrl(sourceUrl),
    });
  }

  await writeJson(designMetaPath(slug), meta);
}

/**
 * Best-effort fallback for the parent-base-slug stored in sibling.json
 * when detection didn't supply one. We strip the trailing style suffix
 * from a slug like `guizang-ppt-skill-swiss` to get `guizang-ppt-skill`.
 */
function baseSlugFromSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname;
    return last.replace(/\.git$/i, "").toLowerCase();
  } catch {
    return "design-system";
  }
}

export async function runProjectIngestion(jobId: string) {
  await ensureDataRoots();
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  ensureProjectJob(job);
  const running = { ...job, status: "running" as const, updatedAt: new Date().toISOString() };
  await saveJob(running);

  let materialized: MaterializedSource | null = null;
  try {
    const sourcePlan = parseProjectSource(job.url);
    materialized = await materializeSource(sourcePlan);
    const fileIndex = await collectFileIndex(materialized.rootDir);
    const textSample = await readTextSample(materialized.rootDir, fileIndex);
    materialized.license = materialized.license ?? (await licenseFromFiles(materialized.rootDir, fileIndex)) ?? "unknown";
    const detection = detectProject(materialized, fileIndex, textSample);
    const baseSlug = detection.slugBase || slugify(materialized.packageName ?? materialized.normalizedUrl ?? materialized.input);
    const slug = job.targetSlug && isSafeDesignSlug(job.targetSlug) ? job.targetSlug : await nextAvailableSlug(baseSlug);
    const createdAt = new Date().toISOString();
    await resetDesignDir(slug, job.targetSlug ? "refresh-project-ingestion" : "project-ingestion");
    const copiedFiles = await copyVendorSnapshot(materialized.rootDir, vendorDir(slug), fileIndex);
    const capabilities = buildCapabilities(detection, fileIndex, textSample);
    const tokens = buildProjectTokens(textSample, detection.packageType);
    const manifest = createManifest(slug, materialized, detection, capabilities, createdAt, copiedFiles);

    // P2 + W7/P4: parse theme markdown files, grouped by source file.
    // A package that ships TWO themes*.md files (e.g. themes.md +
    // themes-swiss.md) is encoding TWO independent visual systems —
    // emit one sibling design per group so each can be picked
    // independently in the gallery.
    const themeFiles = fileIndex.filter((f) => /^references\/themes[^/]*\.md$/i.test(f.path));
    const themesByFile: Array<{
      relativePath: string;
      identity: ThemeFileStyleIdentity;
      themes: ParsedThemeMarkdownBlock[];
    }> = [];
    for (const tf of themeFiles) {
      const content = await readFile(path.join(materialized.rootDir, tf.path), "utf8").catch(() => "");
      if (!content) continue;
      const parsed = parseThemeMarkdown(content);
      if (!parsed.length) continue;
      const identity = inferThemeFileStyle(tf.path, content);
      themesByFile.push({ relativePath: tf.path, identity, themes: parsed });
    }

    // Single-design fallback: flatten all themes into one accentPalette.
    const allThemes = themesByFile.flatMap((g) => g.themes);
    const allThemeSources = themesByFile.flatMap((g) =>
      g.themes.map(() => ({ relativePath: g.relativePath })),
    );
    const parsedThemes = allThemes.length > 0 ? { themes: allThemes, sources: allThemeSources } : undefined;

    // W7/P4 fork: ≥2 distinct theme files with ≥1 theme each → multi-style.
    const isMultiStyle = themesByFile.length >= 2;
    if (isMultiStyle) {
      const siblingPlans = await planSiblingSlugs(baseSlug, themesByFile);
      // Resolve the original slug (already reset on disk) — repurpose it
      // as the FIRST sibling so we don't waste the empty directory.
      if (siblingPlans.length > 0) {
        siblingPlans[0].slug = slug;
      }
      const siblings = siblingPlans.map((p) => ({
        slug: p.slug,
        styleId: p.styleId,
        styleName: p.styleName,
      }));

      for (const plan of siblingPlans) {
        const childParsed = {
          themes: plan.themes,
          sources: plan.themes.map(() => ({ relativePath: plan.sourceFile })),
        };
        const initialCopiedFiles: FileIndexEntry[] = plan.slug === slug ? copiedFiles : [];
        await emitDesignOutput({
          slug: plan.slug,
          isPrimaryReset: plan.slug === slug,
          title: `${detection.name} · ${plan.styleName}`,
          detection,
          capabilities,
          tokens,
          materialized,
          fileIndex,
          copiedFiles: initialCopiedFiles,
          manifest,
          parsedThemes: childParsed,
          textSample,
          job,
          createdAt,
          styleMeta: { styleId: plan.styleId, styleName: plan.styleName, sourceFile: plan.sourceFile },
          siblings,
        });
      }
      await saveJob({
        ...running,
        status: "completed",
        slug: siblings[0]?.slug ?? slug,
        error: undefined,
        diagnostics: undefined,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    const rawProfile = buildProjectProfile(detection, capabilities, tokens, materialized, parsedThemes);
    const assets = await collectProjectPreviewAssets(slug, materialized, fileIndex);
    const evidence = buildProjectEvidence(materialized, detection, fileIndex, capabilities, tokens, textSample, assets);

    // P3a + W6: extract W1.2 CSS evidence from vendor template HTML files.
    // Reads both inline <style> blocks AND any local linked stylesheets
    // (`<link rel="stylesheet" href="relative/path.css">`) — many skill
    // packages ship a single template.html plus a sibling stylesheet, and
    // skipping the linked file would leave the W1.2 extractors empty for
    // the same SPA-style reason that the URL pipeline misses GitHub's
    // structural CSS until it follows linked sheets.
    const templateHtmlFiles = fileIndex.filter((f) => /assets\/template[^/]*\.html$/i.test(f.path));
    if (templateHtmlFiles.length > 0) {
      let cssBundle = "";
      const seenLinked = new Set<string>();
      for (const tf of templateHtmlFiles) {
        const html = await readFile(path.join(materialized.rootDir, tf.path), "utf8").catch(() => "");
        if (!html) continue;
        // 1) all embedded <style> blocks
        const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
        for (const block of styleBlocks) cssBundle += block[1] + "\n";
        // 2) local linked stylesheets (skip http(s) absolute URLs — no
        // egress from project ingestion). Resolved against the template
        // file's own directory.
        const linkMatches = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi)];
        const templateDir = path.dirname(path.join(materialized.rootDir, tf.path));
        for (const linkTag of linkMatches) {
          const hrefMatch = linkTag[0].match(/href=["']([^"']+)["']/i);
          if (!hrefMatch) continue;
          const href = hrefMatch[1];
          if (/^https?:/i.test(href) || /^\/\//.test(href)) continue;
          const cssPath = path.resolve(templateDir, href);
          if (seenLinked.has(cssPath)) continue;
          seenLinked.add(cssPath);
          const cssText = await readFile(cssPath, "utf8").catch(() => "");
          if (cssText) cssBundle += cssText + "\n";
        }
      }
      if (cssBundle.length > 0) {
        const radiusCandidates = extractRadiusCandidates(cssBundle);
        const durationCandidates = extractDurationCandidates(cssBundle);
        const easingCandidates = extractEasingCandidates(cssBundle);
        const fontSizeRatio = extractFontSizeRatio(cssBundle);
        if (radiusCandidates.length > 0) evidence.radiusCandidates = radiusCandidates;
        if (durationCandidates.length > 0) evidence.durationCandidates = durationCandidates;
        if (easingCandidates.length > 0) evidence.easingCandidates = easingCandidates;
        if (fontSizeRatio.sizesPx.length >= 3) evidence.fontSizeRatio = fontSizeRatio;
      }
    }

    const profile = normalizeProfileForEmission(rawProfile, evidence);
    const sourceUrl = materialized.normalizedUrl ?? materialized.packageName ?? materialized.input;
    const meta: DesignMeta = withExecutionProtocolPaths({
      slug,
      title: detection.name,
      sourceUrl,
      sourceHost: sourceHost(materialized),
      sourceMode: "design-system-project",
      sourceChain: [
        {
          role: "requested",
          url: sourceUrl,
          host: sourceHost(materialized),
          title: detection.name,
          note: `Design-system project imported from ${materialized.kind}.`,
        },
      ],
      status: "ready",
      summary: detection.summary,
      tags: normalizeTags([
        packageTypeTag(detection.packageType),
        ...detection.secondaryTypes.map(packageTypeTag),
        ...(detection.hasRootSkill ? ["Skill 包"] : []),
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
    await writeSkillPackage(slug, manifest, capabilities, tokens, copiedFiles);
    await writeText(designDocPath(slug), buildDesignMd(profile, sourceHost(materialized), job.mode, evidence));
    await writeText(openSlideThemePath(slug), buildOpenSlideTheme(profile));
    await writeJson(tokensPath(slug), tokens);
    await writeJson(sourcePath(slug), {
      input: materialized.input,
      kind: materialized.kind,
      normalizedUrl: materialized.normalizedUrl,
      packageName: materialized.packageName ?? materialized.packageJson?.name,
      repository: materialized.repository,
      version: materialized.version,
      commit: materialized.commit,
      license: materialized.license ?? "unknown",
      fetchedAt: createdAt,
      indexedFiles: fileIndex,
      copiedFiles,
      previewAssets: assets,
    });
    await writeJson(evidencePath(slug), evidence);
    await writeJson(profilePath(slug), profile);
    await writeText(previewPath(slug, "web"), renderWebPreview(meta));
    await writeText(previewPath(slug, "ppt"), pptDeckPreview.html);
    await writeText(previewPath(slug, "card"), cardPreview.html);
    await writeExecutionProtocol(meta, cardPreview.html);
    await writeRouterSkill(meta);
    await writeJson(designMetaPath(slug), meta);

    await saveJob({ ...running, status: "completed", slug, error: undefined, diagnostics: undefined, updatedAt: new Date().toISOString() });
  } catch (error) {
    const modelRequest = getModelRequestDiagnostics(error);
    await saveJob({
      ...running,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      diagnostics: modelRequest ? { modelRequest } : running.diagnostics,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    if (materialized?.tempDir) await rm(materialized.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
