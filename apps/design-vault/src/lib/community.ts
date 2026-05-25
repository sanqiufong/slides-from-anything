import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadRegistryBundle, fetchRegistryEntry, uploadBundle } from "./community-client";
import {
  APP_ROOT,
  DATA_ROOT,
  DESIGNS_ROOT,
  PUBLISHED_ROOT,
  designDir,
  designMetaPath,
  ensureDataRoots,
  isSafeDesignSlug,
  readJson,
  writeJson,
} from "./storage";
import type { DesignMeta } from "./types";

const BUNDLE_FORMAT_VERSION = 1;
const SUBMISSION_FILE = "submission.json";
const COMMUNITY_SLUG_PREFIX = "community-";

export type SubmissionManifest = {
  bundleFormatVersion: number;
  slug: string;
  title: string;
  summary: string;
  sourceUrl: string;
  sourceHost: string;
  sourceMode: string;
  archetype?: string;
  qualityScore?: number;
  qualityGrade?: string;
  tags: string[];
  assetCount: number;
  publishedAt: string;
  originHost: {
    appRoot: string;
    dataRoot?: string;
    designsRoot?: string;
    slug: string;
  };
  license: "research-only" | "cc-by-4.0" | "mit" | "custom";
};

export type BundleResult = {
  slug: string;
  title: string;
  bundlePath: string;
  bytes: number;
  version: number;
  submission: SubmissionManifest;
};

export type InstallResult = {
  slug: string;
  upstreamSlug: string;
  title: string;
  designDir: string;
  submission: SubmissionManifest;
};

export async function bundleDesign(slug: string): Promise<BundleResult> {
  if (!isSafeDesignSlug(slug)) throw new Error(`Invalid design slug: ${slug}`);
  await ensureDataRoots();
  const meta = await readJson<DesignMeta>(designMetaPath(slug));
  if (!meta) throw new Error(`Design not found: ${slug}`);
  const source = designDir(slug);
  if (!(await directoryExists(source))) throw new Error(`Design directory missing: ${source}`);

  const stage = await mkdtemp(path.join(os.tmpdir(), `design-vault-publish-${slug}-`));
  try {
    await cp(source, stage, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(source, src);
        if (!rel) return true;
        const first = rel.split(path.sep)[0];
        return first !== "vendor";
      },
    });

    const submission: SubmissionManifest = {
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      slug: meta.slug,
      title: meta.title,
      summary: meta.summary,
      sourceUrl: meta.sourceUrl,
      sourceHost: meta.sourceHost,
      sourceMode: meta.sourceMode,
      archetype: meta.profile?.archetype,
      qualityScore: meta.profile?.quality?.score,
      qualityGrade: meta.profile?.quality?.grade,
      tags: meta.tags ?? [],
      assetCount: meta.assets?.length ?? 0,
      publishedAt: new Date().toISOString(),
      originHost: {
        appRoot: inferAppRootFromMeta(meta) ?? APP_ROOT,
        dataRoot: DATA_ROOT,
        designsRoot: DESIGNS_ROOT,
        slug: meta.slug,
      },
      license: "research-only",
    };
    await writeFile(path.join(stage, SUBMISSION_FILE), `${JSON.stringify(submission, null, 2)}\n`, "utf8");

    await mkdir(PUBLISHED_ROOT, { recursive: true });
    const bundlePath = path.join(PUBLISHED_ROOT, `${slug}-v${BUNDLE_FORMAT_VERSION}.tgz`);
    await runTar(["-czf", bundlePath, "-C", stage, "."]);
    const { size } = await stat(bundlePath);
    return {
      slug: meta.slug,
      title: meta.title,
      bundlePath,
      bytes: size,
      version: BUNDLE_FORMAT_VERSION,
      submission,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function installBundle(tarPath: string, options: { sourceLabel?: string; publisher?: string } = {}): Promise<InstallResult> {
  await ensureDataRoots();
  if (!(await fileExists(tarPath))) throw new Error(`Bundle not found: ${tarPath}`);

  const stage = await mkdtemp(path.join(os.tmpdir(), "design-vault-install-"));
  try {
    await runTar(["-xzf", tarPath, "-C", stage]);
    const submission = await readJson<SubmissionManifest>(path.join(stage, SUBMISSION_FILE));
    if (!submission) throw new Error("Bundle missing submission.json — not a Design Vault community bundle.");
    if (typeof submission.slug !== "string" || typeof submission.title !== "string") {
      throw new Error("submission.json is missing required fields (slug/title).");
    }
    const upstreamSlug = submission.slug;
    const targetSlug = upstreamSlug.startsWith(COMMUNITY_SLUG_PREFIX) ? upstreamSlug : `${COMMUNITY_SLUG_PREFIX}${upstreamSlug}`;
    if (!isSafeDesignSlug(targetSlug)) throw new Error(`Computed install slug is unsafe: ${targetSlug}`);

    const targetDir = path.join(DESIGNS_ROOT, targetSlug);
    if (await directoryExists(targetDir)) {
      throw new Error(`本地已存在 ${targetSlug}，请先在资料库删除后再重新导入。`);
    }

    const fromRoot = submission.originHost?.appRoot ?? "";
    const fromDesignsRoot = submission.originHost?.designsRoot ?? (fromRoot ? path.join(fromRoot, "data", "designs") : "");
    await rewriteJsonFilesRecursively(
      stage,
      fromRoot,
      APP_ROOT,
      fromDesignsRoot,
      DESIGNS_ROOT,
      upstreamSlug,
      targetSlug,
      new Set([SUBMISSION_FILE]),
    );

    await mkdir(targetDir, { recursive: true });
    const entries = await readdir(stage, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === SUBMISSION_FILE) continue;
      const from = path.join(stage, entry.name);
      const to = path.join(targetDir, entry.name);
      await cp(from, to, { recursive: true });
    }

    const metaPath = path.join(targetDir, "meta.json");
    const meta = await readJson<DesignMeta>(metaPath);
    if (!meta) throw new Error("Installed bundle missing meta.json after extraction.");
    const patched: DesignMeta = {
      ...meta,
      slug: targetSlug,
      origin: "community",
      community: {
        origin: "community",
        bundleVersion: submission.bundleFormatVersion ?? BUNDLE_FORMAT_VERSION,
        installedAt: new Date().toISOString(),
        installedFrom: options.sourceLabel ?? path.basename(tarPath),
        upstreamSlug,
        publisher: options.publisher,
      },
      updatedAt: new Date().toISOString(),
    };
    await writeJson(metaPath, patched);

    return { slug: targetSlug, upstreamSlug, title: meta.title, designDir: targetDir, submission };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function publishToServer(slug: string): Promise<{ bundle: BundleResult; submissionId: string; status: string }> {
  const bundle = await bundleDesign(slug);
  const buffer = await readFile(bundle.bundlePath);
  const result = await uploadBundle(buffer, path.basename(bundle.bundlePath));
  return { bundle, submissionId: result.submissionId, status: result.status };
}

export async function installFromRegistry(slug: string): Promise<InstallResult> {
  if (!isSafeDesignSlug(slug)) throw new Error(`Invalid slug: ${slug}`);
  // Capture publisher metadata before downloading so we can attribute the install.
  const entry = await fetchRegistryEntry(slug).catch(() => null);
  const buffer = await downloadRegistryBundle(slug);
  await ensureDataRoots();
  await mkdir(PUBLISHED_ROOT, { recursive: true });
  const tempPath = path.join(PUBLISHED_ROOT, `incoming-${Date.now()}-${slug}.tgz`);
  await writeFile(tempPath, buffer);
  try {
    return await installBundle(tempPath, {
      sourceLabel: `registry:${slug}`,
      publisher: entry?.publisher?.login,
    });
  } finally {
    await rm(tempPath, { force: true });
  }
}

function inferAppRootFromMeta(meta: DesignMeta): string | null {
  const candidates: Array<{ value?: string; suffix: string }> = [
    { value: meta.designPath, suffix: `/data/designs/${meta.slug}/design.md` },
    { value: meta.evidencePath, suffix: `/data/designs/${meta.slug}/evidence.json` },
    { value: meta.profilePath, suffix: `/data/designs/${meta.slug}/profile.json` },
    { value: meta.openSlideThemePath, suffix: `/data/designs/${meta.slug}/open-slide-theme.md` },
  ];
  for (const candidate of candidates) {
    if (typeof candidate.value === "string" && candidate.value.endsWith(candidate.suffix)) {
      return candidate.value.slice(0, -candidate.suffix.length);
    }
  }
  const dataRootSuffix = `/designs/${meta.slug}/design.md`;
  if (typeof meta.designPath === "string" && meta.designPath.startsWith(DATA_ROOT) && meta.designPath.endsWith(dataRootSuffix)) {
    return APP_ROOT;
  }
  return null;
}

async function directoryExists(target: string) {
  try {
    const s = await stat(target);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(target: string) {
  try {
    const s = await stat(target);
    return s.isFile();
  } catch {
    return false;
  }
}

function runTar(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar ${args[0]} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function rewriteJsonFilesRecursively(
  root: string,
  fromRoot: string,
  toRoot: string,
  fromDesignsRoot: string,
  toDesignsRoot: string,
  fromSlug: string,
  toSlug: string,
  skipNames: Set<string>,
) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await rewriteJsonFilesRecursively(full, fromRoot, toRoot, fromDesignsRoot, toDesignsRoot, fromSlug, toSlug, skipNames);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json") && !skipNames.has(entry.name)) {
      try {
        const text = await readFile(full, "utf8");
        const parsed = JSON.parse(text);
        const rewritten = rewriteJsonValue(parsed, fromRoot, toRoot, fromDesignsRoot, toDesignsRoot, fromSlug, toSlug);
        await writeFile(full, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
      } catch {
        // ignore files that are not valid JSON
      }
    }
  }
}

function rewriteJsonValue(
  value: unknown,
  fromRoot: string,
  toRoot: string,
  fromDesignsRoot: string,
  toDesignsRoot: string,
  fromSlug: string,
  toSlug: string,
): unknown {
  if (typeof value === "string") {
    let v = value;
    if (fromDesignsRoot) {
      const fromDesignDir = path.join(fromDesignsRoot, fromSlug);
      const toDesignDir = path.join(toDesignsRoot, toSlug);
      if (v.includes(fromDesignDir)) v = v.split(fromDesignDir).join(toDesignDir);
    }
    if (fromRoot && v.includes(fromRoot)) v = v.split(fromRoot).join(toRoot);
    if (fromSlug !== toSlug) {
      const fromSegment = `/designs/${fromSlug}/`;
      const toSegment = `/designs/${toSlug}/`;
      v = v.split(fromSegment).join(toSegment);
      const fromTrail = `/designs/${fromSlug}`;
      const toTrail = `/designs/${toSlug}`;
      if (v.endsWith(fromTrail)) v = `${v.slice(0, -fromTrail.length)}${toTrail}`;
    }
    return v;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteJsonValue(item, fromRoot, toRoot, fromDesignsRoot, toDesignsRoot, fromSlug, toSlug));
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      next[key] = rewriteJsonValue(child, fromRoot, toRoot, fromDesignsRoot, toDesignsRoot, fromSlug, toSlug);
    }
    return next;
  }
  return value;
}
