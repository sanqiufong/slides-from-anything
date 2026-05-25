import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    slug: string;
  };
  license: string;
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const SUPPORTED_FORMATS = new Set([1]);

export class BundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleValidationError";
  }
}

export async function extractAndValidate(buffer: Buffer): Promise<SubmissionManifest> {
  const stage = await mkdtemp(path.join(os.tmpdir(), "dv-validate-"));
  const tarPath = path.join(stage, "bundle.tgz");
  const extractDir = path.join(stage, "extracted");
  try {
    await writeFile(tarPath, buffer);
    await mkdir(extractDir, { recursive: true });
    // Extract the whole bundle into a sub-dir. Asking tar for a specific
    // member like `submission.json` is fragile across BSD vs GNU tar when the
    // creator (e.g. macOS) prefixed every entry with `./`. Extracting all is
    // robust; the bundle is small (≤80MB) and the temp dir is scrubbed below.
    await runTar(["-xzf", tarPath, "-C", extractDir]);
    const submissionPath = path.join(extractDir, "submission.json");
    let raw: string;
    try {
      raw = await readFile(submissionPath, "utf8");
    } catch {
      throw new BundleValidationError(
        "Bundle 内未找到 submission.json — 请在本地用 publish-design 或卡片 📦 按钮重新生成。",
      );
    }
    const parsed = JSON.parse(raw) as unknown;
    return assertManifest(parsed);
  } catch (error) {
    if (error instanceof BundleValidationError) throw error;
    throw new BundleValidationError(
      `无法读取 submission.json：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function assertManifest(value: unknown): SubmissionManifest {
  if (!isObject(value)) throw new BundleValidationError("submission.json 不是对象。");
  const bundleFormatVersion = expectNumber(value, "bundleFormatVersion");
  if (!SUPPORTED_FORMATS.has(bundleFormatVersion)) {
    throw new BundleValidationError(`不支持的 bundleFormatVersion: ${bundleFormatVersion}`);
  }
  const slug = expectString(value, "slug");
  if (!SLUG_RE.test(slug)) {
    throw new BundleValidationError(`slug 非法（必须 ^[a-z0-9][a-z0-9-]*$）: ${slug}`);
  }
  if (slug.startsWith("community-")) {
    throw new BundleValidationError("slug 不能以 community- 开头（保留给客户端安装时自动加的前缀）。");
  }
  const title = expectString(value, "title");
  const summary = optionalString(value, "summary") ?? "";
  const sourceUrl = optionalString(value, "sourceUrl") ?? "";
  const sourceHost = optionalString(value, "sourceHost") ?? "";
  const sourceMode = optionalString(value, "sourceMode") ?? "url";
  const archetype = optionalString(value, "archetype") ?? undefined;
  const qualityScore = optionalNumber(value, "qualityScore") ?? undefined;
  const qualityGrade = optionalString(value, "qualityGrade") ?? undefined;
  const tags = optionalStringArray(value, "tags") ?? [];
  const assetCount = optionalNumber(value, "assetCount") ?? 0;
  const publishedAt = optionalString(value, "publishedAt") ?? new Date().toISOString();
  const license = optionalString(value, "license") ?? "research-only";

  const originHost = value.originHost;
  if (!isObject(originHost)) throw new BundleValidationError("originHost 缺失或不是对象。");
  const originAppRoot = optionalString(originHost, "appRoot");
  if (!originAppRoot || originAppRoot.includes("..")) {
    throw new BundleValidationError("originHost.appRoot 非法或包含 ..");
  }
  const originSlug = optionalString(originHost, "slug") ?? slug;

  return {
    bundleFormatVersion,
    slug,
    title,
    summary,
    sourceUrl,
    sourceHost,
    sourceMode,
    archetype,
    qualityScore,
    qualityGrade,
    tags,
    assetCount,
    publishedAt,
    originHost: { appRoot: originAppRoot, slug: originSlug },
    license,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new BundleValidationError(`字段 ${key} 必须是非空字符串。`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function expectNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new BundleValidationError(`字段 ${key} 必须是数字。`);
  }
  return v;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === "string");
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
      else reject(new BundleValidationError(`tar ${args[0]} 退出码 ${code}: ${stderr.trim()}`));
    });
  });
}
