import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { WORKSPACE_ROOT, type ToolPackCliOptions } from "./config.js";

const RELEASE_DIR_NAME = "Slides-from-Anything-portable";
const RELEASE_MARKER = ".sfa-release";
const CHINESE_LAUNCHER_NAME = "\u542f\u52a8\u96c6\u6210\u9879\u76ee.command";

const ROOT_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "QUICKSTART.md",
  "README.md",
  "README.zh-CN.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "start.command",
  "tsconfig.base.json",
] as const;

const ROOT_DIRECTORIES = [
  "apps",
  "design-systems",
  "docs",
  "node_modules",
  "packages",
  "prompt-templates",
  "scripts",
  "skills",
  "tools",
] as const;

const OPTIONAL_ROOT_DIRECTORIES = ["assets", "craft"] as const;

const PRUNED_WORKSPACE_PATHS = [
  "apps/desktop",
  "apps/packaged",
  "tools/pack",
] as const;

const PRUNED_PNPM_PACKAGE_PREFIXES = [
  "7zip-bin@",
  "@electron+",
  "app-builder-bin@",
  "app-builder-lib@",
  "builder-util-runtime@",
  "builder-util@",
  "dmg-builder@",
  "electron-builder-squirrel-windows@",
  "electron-builder@",
  "electron-publish@",
  "electron-to-chromium@",
  "electron-winstaller@",
  "electron@",
  "postject@",
] as const;

const PRUNED_NODE_MODULE_LINKS = [
  join("node_modules", ".bin", "tools-pack"),
  join("node_modules", "@open-design", "tools-pack"),
  join("node_modules", ".pnpm", "node_modules", "7zip-bin"),
  join("node_modules", ".pnpm", "node_modules", "app-builder-bin"),
  join("node_modules", ".pnpm", "node_modules", "app-builder-lib"),
  join("node_modules", ".pnpm", "node_modules", "builder-util"),
  join("node_modules", ".pnpm", "node_modules", "builder-util-runtime"),
  join("node_modules", ".pnpm", "node_modules", "dmg-builder"),
  join("node_modules", ".pnpm", "node_modules", "electron"),
  join("node_modules", ".pnpm", "node_modules", "electron-builder"),
  join("node_modules", ".pnpm", "node_modules", "electron-builder-squirrel-windows"),
  join("node_modules", ".pnpm", "node_modules", "electron-publish"),
  join("node_modules", ".pnpm", "node_modules", "electron-winstaller"),
] as const;

function toPosix(value: string): string {
  return value.split(/[\\/]+/).join("/");
}

function isSkippedPath(repositoryPath: string): boolean {
  const segments = repositoryPath.split("/");
  if (segments.some((segment) => segment === ".git" || segment === ".tmp" || segment === ".od")) {
    return true;
  }
  if (segments.some((segment) => segment === "tests")) {
    return true;
  }
  if (segments.some((segment) => segment === ".next" || segment.startsWith(".next-"))) {
    return true;
  }
  if (segments.some((segment) => segment === ".vite" || segment === ".turbo")) {
    return true;
  }
  if (repositoryPath === "apps/design-vault/data" || repositoryPath.startsWith("apps/design-vault/data/")) {
    return true;
  }
  if (repositoryPath === "apps/design-vault/tmp" || repositoryPath.startsWith("apps/design-vault/tmp/")) {
    return true;
  }
  if (repositoryPath === "apps/design-vault/.local" || repositoryPath.startsWith("apps/design-vault/.local/")) {
    return true;
  }
  if (PRUNED_WORKSPACE_PATHS.some((prunedPath) => repositoryPath === prunedPath || repositoryPath.startsWith(`${prunedPath}/`))) {
    return true;
  }
  return false;
}

async function copyWorkspaceEntry(entry: string, packageRoot: string): Promise<void> {
  const source = join(WORKSPACE_ROOT, entry);
  if (!existsSync(source)) return;
  const target = join(packageRoot, entry);
  await cp(source, target, {
    dereference: false,
    force: true,
    preserveTimestamps: true,
    recursive: true,
    verbatimSymlinks: true,
    filter(src) {
      const repositoryPath = toPosix(relative(WORKSPACE_ROOT, src));
      return repositoryPath.length === 0 || !isSkippedPath(repositoryPath);
    },
  });
}

function resolveNodeBinaryPath(): string {
  const nodeBin = process.execPath;
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 24) {
    throw new Error(`integrated release requires Node 24.x, got ${process.version} at ${nodeBin}`);
  }
  return nodeBin;
}

async function copyNodeRuntime(packageRoot: string): Promise<string> {
  const source = resolveNodeBinaryPath();
  const target = join(packageRoot, "runtime", "node");
  await rm(target, { force: true, recursive: true });
  const nodePath = process.platform === "win32" ? join(target, "node.exe") : join(target, "bin", "node");
  await mkdir(dirname(nodePath), { recursive: true });
  await cp(source, nodePath, {
    dereference: true,
    force: true,
    preserveTimestamps: true,
  });
  if (!existsSync(nodePath)) {
    throw new Error(`bundled Node copy did not create ${nodePath}`);
  }
  await chmod(nodePath, 0o755).catch(() => undefined);
  return nodePath;
}

function isPrunedPnpmPackage(entryName: string): boolean {
  return PRUNED_PNPM_PACKAGE_PREFIXES.some((prefix) => entryName.startsWith(prefix));
}

async function prunePnpmStore(packageRoot: string): Promise<void> {
  const pnpmStore = join(packageRoot, "node_modules", ".pnpm");
  if (!existsSync(pnpmStore)) return;

  for (const entry of await readdir(pnpmStore, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isPrunedPnpmPackage(entry.name)) continue;
    await rm(join(pnpmStore, entry.name), { force: true, recursive: true });
  }

  for (const linkPath of PRUNED_NODE_MODULE_LINKS) {
    await rm(join(packageRoot, linkPath), { force: true, recursive: true });
  }

  for (const scope of ["@electron"]) {
    await rm(join(packageRoot, "node_modules", ".pnpm", "node_modules", scope), {
      force: true,
      recursive: true,
    });
  }
}

async function writeReleaseMetadata(packageRoot: string, bundledNodePath: string): Promise<void> {
  await writeFile(
    join(packageRoot, RELEASE_MARKER),
    `${JSON.stringify(
      {
        bundledNodePath: relative(packageRoot, bundledNodePath),
        createdAt: new Date().toISOString(),
        nodeVersion: process.version,
        platform: process.platform,
        pnpm: "bundled node_modules; launch skips install",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const launcher = [
    "#!/usr/bin/env bash",
    "DIR=\"$(cd \"$(dirname \"$0\")\" && pwd)\"",
    "exec \"$DIR/scripts/start-integrated.sh\"",
    "",
  ].join("\n");
  await writeFile(join(packageRoot, CHINESE_LAUNCHER_NAME), launcher, "utf8");
  await chmod(join(packageRoot, CHINESE_LAUNCHER_NAME), 0o755);

  await writeFile(
    join(packageRoot, "README-START.txt"),
    [
      "Slides from Anything portable package",
      "",
      "Double-click start.command on macOS, or run:",
      "  ./start.command",
      "",
      "This package uses runtime/node and bundled node_modules.",
      "It does not require a system Node.js or pnpm install step.",
      "",
      "Runtime data and logs are written under .tmp/integrated.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function createZip(packageRoot: string): string | null {
  const parent = dirname(packageRoot);
  const zipPath = `${packageRoot}.zip`;
  const packageName = basename(packageRoot);

  if (process.platform === "darwin" && existsSync("/usr/bin/ditto")) {
    const result = spawnSync(
      "/usr/bin/ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", packageName, zipPath],
      { cwd: parent, stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(`ditto failed with status ${result.status ?? "unknown"}`);
    }
    return zipPath;
  }

  const result = spawnSync("zip", ["-qry", "--symlinks", zipPath, packageName], {
    cwd: parent,
    stdio: "inherit",
  });
  if (result.error != null) return null;
  if (result.status !== 0) {
    throw new Error(`zip failed with status ${result.status ?? "unknown"}`);
  }
  return zipPath;
}

export type IntegratedReleaseResult = {
  bundledNodePath: string;
  packageRoot: string;
  skippedInstall: true;
  zipPath: string | null;
};

export async function packIntegratedRelease(options: ToolPackCliOptions = {}): Promise<IntegratedReleaseResult> {
  const outputRoot = resolve(options.dir ?? join(WORKSPACE_ROOT, "releases", "integrated"));
  const packageRoot = join(outputRoot, RELEASE_DIR_NAME);
  await rm(packageRoot, { force: true, recursive: true });
  await mkdir(packageRoot, { recursive: true });

  for (const file of ROOT_FILES) {
    await copyWorkspaceEntry(file, packageRoot);
  }
  for (const directory of ROOT_DIRECTORIES) {
    await copyWorkspaceEntry(directory, packageRoot);
  }
  for (const directory of OPTIONAL_ROOT_DIRECTORIES) {
    await copyWorkspaceEntry(directory, packageRoot);
  }
  await prunePnpmStore(packageRoot);

  const bundledNodePath = await copyNodeRuntime(packageRoot);
  await writeReleaseMetadata(packageRoot, bundledNodePath);
  const zipPath = createZip(packageRoot);

  return {
    bundledNodePath,
    packageRoot,
    skippedInstall: true,
    zipPath,
  };
}
