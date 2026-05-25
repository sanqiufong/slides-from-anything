import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import { env } from "./env";

const INCOMING = "incoming";
const PUBLISHED = "published";

export type StoredBundle = {
  sha256: string;
  bytes: number;
  storedPath: string;
  relativePath: string;
};

export async function ensureRoots() {
  await mkdir(path.join(env.bundleStorageRoot, INCOMING), { recursive: true });
  await mkdir(path.join(env.bundleStorageRoot, PUBLISHED), { recursive: true });
}

export async function storeIncoming(buffer: Buffer): Promise<StoredBundle> {
  await ensureRoots();
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const relativePath = path.posix.join(INCOMING, `${sha256}.tgz`);
  const storedPath = path.join(env.bundleStorageRoot, relativePath);
  if (!(await pathExists(storedPath))) {
    await writeFile(storedPath, buffer, { mode: 0o644 });
  }
  return { sha256, bytes: buffer.byteLength, storedPath, relativePath };
}

export async function promoteToPublished(
  incomingRelativePath: string,
  slug: string,
  version: number,
  sha256: string,
): Promise<string> {
  await ensureRoots();
  const targetDir = path.join(env.bundleStorageRoot, PUBLISHED, slug);
  await mkdir(targetDir, { recursive: true });
  const targetName = `v${version}-${sha256}.tgz`;
  const targetAbs = path.join(targetDir, targetName);
  const sourceAbs = path.join(env.bundleStorageRoot, incomingRelativePath);
  await rename(sourceAbs, targetAbs);
  return path.posix.join(PUBLISHED, slug, targetName);
}

export async function removeBundleFile(relativePath: string): Promise<void> {
  try {
    await unlink(path.join(env.bundleStorageRoot, relativePath));
  } catch {
    // ignore
  }
}

export function absoluteBundlePath(relativePath: string): string {
  return path.join(env.bundleStorageRoot, relativePath);
}

export async function bundleExists(relativePath: string): Promise<boolean> {
  return pathExists(path.join(env.bundleStorageRoot, relativePath));
}

async function pathExists(target: string) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
