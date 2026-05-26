import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeTags } from "./tags";
import type { DesignMeta, IngestionJob } from "./types";

export const APP_ROOT = process.cwd();

function resolveDataRoot() {
  const configured = process.env.DESIGN_VAULT_DATA_DIR?.trim();
  if (!configured) return path.join(APP_ROOT, "data");
  const expanded = configured.startsWith("~/") ? path.join(process.env.HOME ?? "", configured.slice(2)) : configured;
  return path.resolve(expanded);
}

export const DATA_ROOT = resolveDataRoot();
export const DESIGNS_ROOT = path.join(DATA_ROOT, "designs");
export const JOBS_ROOT = path.join(DATA_ROOT, "jobs");
export const JOB_LOGS_ROOT = path.join(JOBS_ROOT, "logs");
export const ROUTER_SKILL_ROOT = path.join(DATA_ROOT, "router-skill");
export const DESIGN_ARCHIVE_ROOT = path.join(DATA_ROOT, "design-archives");
export const PUBLISHED_ROOT = path.join(DATA_ROOT, "published");
export const FAVORITES_PATH = path.join(DATA_ROOT, "favorites.json");

export async function ensureDataRoots() {
  await mkdir(DESIGNS_ROOT, { recursive: true });
  await mkdir(JOBS_ROOT, { recursive: true });
  await mkdir(JOB_LOGS_ROOT, { recursive: true });
  await mkdir(DESIGN_ARCHIVE_ROOT, { recursive: true });
  await mkdir(PUBLISHED_ROOT, { recursive: true });
}

export function designDir(slug: string) {
  return path.join(DESIGNS_ROOT, slug);
}

export function isSafeDesignSlug(slug: string) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

export async function deleteDesign(slug: string) {
  if (!isSafeDesignSlug(slug)) return false;
  const target = path.resolve(DESIGNS_ROOT, slug);
  const root = path.resolve(DESIGNS_ROOT);
  if (!target.startsWith(`${root}${path.sep}`)) return false;

  const exists = await pathExists(target);
  if (!exists) return false;
  await archiveDesign(slug, "delete");
  await rm(target, { recursive: true, force: true });
  return true;
}

function archiveStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function archiveDesign(slug: string, reason: string) {
  if (!isSafeDesignSlug(slug)) return null;
  const target = path.resolve(DESIGNS_ROOT, slug);
  const root = path.resolve(DESIGNS_ROOT);
  if (!target.startsWith(`${root}${path.sep}`)) return null;
  if (!(await pathExists(target))) return null;

  await mkdir(DESIGN_ARCHIVE_ROOT, { recursive: true });
  const archiveDir = path.join(DESIGN_ARCHIVE_ROOT, `${archiveStamp()}-${slug}`);
  await cp(target, archiveDir, { recursive: true, errorOnExist: true, force: false });
  await writeJson(path.join(archiveDir, "archive.json"), {
    slug,
    reason,
    archivedAt: new Date().toISOString(),
    sourcePath: target,
  });
  return archiveDir;
}

export async function resetDesignDir(slug: string, reason: string) {
  if (!isSafeDesignSlug(slug)) throw new Error(`Invalid design slug: ${slug}`);
  const target = path.resolve(DESIGNS_ROOT, slug);
  const root = path.resolve(DESIGNS_ROOT);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe design path: ${target}`);
  await archiveDesign(slug, reason);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

export function designAssetsDir(slug: string) {
  return path.join(designDir(slug), "assets");
}

export function designMetaPath(slug: string) {
  return path.join(designDir(slug), "meta.json");
}

export function designDocPath(slug: string) {
  return path.join(designDir(slug), "design.md");
}

export function openSlideThemePath(slug: string) {
  return path.join(designDir(slug), "open-slide-theme.md");
}

export function tokensPath(slug: string) {
  return path.join(designDir(slug), "tokens.json");
}

export function sourcePath(slug: string) {
  return path.join(designDir(slug), "source.json");
}

export function evidencePath(slug: string) {
  return path.join(designDir(slug), "evidence.json");
}

export function profilePath(slug: string) {
  return path.join(designDir(slug), "profile.json");
}

export function productDocPath(slug: string) {
  return path.join(designDir(slug), "PRODUCT.md");
}

export function designSpecPath(slug: string) {
  return path.join(designDir(slug), "execution", "DESIGN.md");
}

export function styleCardPath(slug: string) {
  return path.join(designDir(slug), "STYLE_CARD.html");
}

export function antiPatternsPath(slug: string) {
  return path.join(designDir(slug), "anti-patterns.json");
}

export function qualityGatesPath(slug: string) {
  return path.join(designDir(slug), "quality-gates.json");
}

export function manifestPath(slug: string) {
  return path.join(designDir(slug), "manifest.json");
}

export function capabilitiesPath(slug: string) {
  return path.join(designDir(slug), "capabilities.json");
}

export function vendorDir(slug: string) {
  return path.join(designDir(slug), "vendor");
}

export function skillDir(slug: string) {
  return path.join(designDir(slug), "skill");
}

export function skillPath(slug: string) {
  return path.join(skillDir(slug), "SKILL.md");
}

export function previewPath(slug: string, kind: "web" | "ppt" | "card") {
  return path.join(designDir(slug), "previews", `${kind}.html`);
}

export function routerSkillDir() {
  return ROUTER_SKILL_ROOT;
}

export function routerSkillPath() {
  return path.join(routerSkillDir(), "SKILL.md");
}

export function routerRegistryPath() {
  return path.join(routerSkillDir(), "registry.json");
}

export function jobPath(jobId: string) {
  return path.join(JOBS_ROOT, `${jobId}.json`);
}

export function jobLogPath(jobId: string) {
  return path.join(JOB_LOGS_ROOT, `${jobId}.log`);
}

export async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function readText(filePath: string) {
  return readFile(filePath, "utf8");
}

export async function writeText(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

export async function listDesigns(): Promise<DesignMeta[]> {
  await ensureDataRoots();
  const dirs = await readdir(DESIGNS_ROOT, { withFileTypes: true });
  const items = await Promise.all(
    dirs.filter((entry) => entry.isDirectory()).map((entry) => readJson<DesignMeta>(designMetaPath(entry.name))),
  );
  return items.filter(Boolean).sort((a, b) => b!.updatedAt.localeCompare(a!.updatedAt)) as DesignMeta[];
}

type FavoritesFile = {
  slugs: string[];
  updatedAt: string;
};

export async function readFavorites(): Promise<Set<string>> {
  const data = await readJson<FavoritesFile>(FAVORITES_PATH);
  if (!data || !Array.isArray(data.slugs)) return new Set();
  return new Set(data.slugs.filter((slug): slug is string => typeof slug === "string" && isSafeDesignSlug(slug)));
}

export async function setFavorite(slug: string, favorite: boolean): Promise<Set<string> | null> {
  if (!isSafeDesignSlug(slug)) return null;
  const design = await getDesign(slug);
  if (!design) return null;
  const current = await readFavorites();
  if (favorite) current.add(slug);
  else current.delete(slug);
  const payload: FavoritesFile = {
    slugs: [...current].sort(),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(FAVORITES_PATH, payload);
  return current;
}

export async function getDesign(slug: string) {
  return readJson<DesignMeta>(designMetaPath(slug));
}

export async function updateDesignTags(slug: string, tags: unknown) {
  if (!isSafeDesignSlug(slug)) return null;
  const design = await getDesign(slug);
  if (!design) return null;
  const updated: DesignMeta = {
    ...design,
    tags: normalizeTags(tags),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(designMetaPath(slug), updated);
  return updated;
}

export async function getJob(jobId: string) {
  return readJson<IngestionJob>(jobPath(jobId));
}

export async function saveJob(job: IngestionJob) {
  await writeJson(jobPath(job.id), job);
}

export async function pathExists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
