import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { absoluteBundlePath, bundleExists } from "./bundle-store";
import { env } from "./env";

export type PreviewKind = "card" | "web" | "ppt" | "style";

function cacheRoot() {
  return path.join(env.bundleStorageRoot, "cache");
}

/**
 * Ensure the bundle identified by sha256 is extracted on disk and return the
 * extracted directory. Subsequent calls reuse the cache. Each extraction is
 * atomic via temp-dir + rename; concurrent first-time extracts of the same
 * bundle race-safely fall back to the winner.
 */
export async function ensureBundleExtracted(bundleRelPath: string, sha256: string): Promise<string | null> {
  if (!(await bundleExists(bundleRelPath))) return null;
  const target = path.join(cacheRoot(), sha256);
  try {
    const s = await stat(target);
    if (s.isDirectory()) return target;
  } catch {
    // not cached yet
  }
  await mkdir(cacheRoot(), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await mkdir(tmp, { recursive: true });
  const tarPath = absoluteBundlePath(bundleRelPath);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tar", ["-xzf", tarPath, "-C", tmp], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar -xzf exit ${code}: ${stderr.trim()}`))));
      child.on("error", reject);
    });
    try {
      await rename(tmp, target);
    } catch {
      // Lost the race to a concurrent extractor — drop ours, use theirs.
      await rm(tmp, { recursive: true, force: true });
    }
    return target;
  } catch {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

export async function extractPreviewHtml(
  bundleRelPath: string,
  sha256: string,
  kind: PreviewKind,
): Promise<string | null> {
  const root = await ensureBundleExtracted(bundleRelPath, sha256);
  if (!root) return null;
  const relPath = kind === "style" ? "STYLE_CARD.html" : path.join("previews", `${kind}.html`);
  return readFile(path.join(root, relPath), "utf8").catch(() => null);
}

/**
 * Safe path resolver. Refuses any input that would escape the bundle root via
 * `..` traversal or absolute paths.
 */
export function resolveBundleFile(extractedRoot: string, requested: string): string | null {
  const normalized = path.normalize(requested).replace(/^[\\/]+/, "");
  if (normalized.includes("..")) return null;
  const full = path.join(extractedRoot, normalized);
  if (!full.startsWith(extractedRoot + path.sep) && full !== extractedRoot) return null;
  return full;
}
