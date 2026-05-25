import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  type AppKey,
  type DaemonStatusSnapshot,
  type SidecarStamp,
  type WebStatusSnapshot,
} from "@open-design/sidecar-proto";
import {
  createSidecarLaunchEnv,
  requestJsonIpc,
  resolveAppIpcPath,
  type SidecarRuntimeContext,
} from "@open-design/sidecar";
import { createProcessStampArgs, stopProcesses, waitForProcessExit } from "@open-design/platform";

import type { PackagedWebOutputMode } from "./config.js";
import type { PackagedNamespacePaths } from "./paths.js";

const require = createRequire(import.meta.url);
const PACKAGED_CHILD_ENV_ALLOWLIST = ["HOME", "LANG", "LC_ALL", "LOGNAME", "TMPDIR", "USER"] as const;
const PACKAGED_PROXY_ENV_ALLOWLIST = [
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
const ENV_PROXY_NODE_OPTION = "--use-env-proxy";
const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";
const execFileAsync = promisify(execFile);

function shouldForwardPackagedChildEnv(key: string, includeProviderSecrets = false): boolean {
  return (
    PACKAGED_CHILD_ENV_ALLOWLIST.includes(
      key as (typeof PACKAGED_CHILD_ENV_ALLOWLIST)[number],
    ) ||
    PACKAGED_PROXY_ENV_ALLOWLIST.includes(
      key as (typeof PACKAGED_PROXY_ENV_ALLOWLIST)[number],
    ) ||
    (includeProviderSecrets && (key.endsWith("_API_KEY") || key.endsWith("_TOKEN")))
  );
}

export type PackagedSidecarHandle = {
  close(): Promise<void>;
  daemon: DaemonStatusSnapshot;
  web: WebStatusSnapshot;
};

type ManagedSidecarChild = {
  app: AppKey;
  child: ChildProcess;
  ipcPath: string;
  logHandle: FileHandle;
};

type PackagedDaemonManagedPathEnv = {
  OD_DATA_DIR: string;
  OD_RESOURCE_ROOT: string;
};

function resolveSidecarEntry(packageName: string, exportName: string): string {
  return require.resolve(`${packageName}/${exportName}`);
}

function logPathFor(paths: PackagedNamespacePaths, app: AppKey): string {
  return join(paths.logsRoot, app, "latest.log");
}

async function openLog(path: string): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true });
  return await open(path, "w");
}

async function waitForStatus<T>(
  ipcPath: string,
  isReady: (status: T) => boolean,
  timeoutMs = 35_000,
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const status = await requestJsonIpc<T>(
        ipcPath,
        { type: SIDECAR_MESSAGES.STATUS },
        { timeoutMs: 800 },
      );
      if (isReady(status)) return status;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }

  throw new Error(
    `timed out waiting for sidecar status at ${ipcPath}${
      lastError instanceof Error ? ` (${lastError.message})` : ""
    }`,
  );
}

function extractPort(url: string): string {
  const parsed = new URL(url);
  return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
}

function existingDirsUnder(root: string, segments: string[] = []): string[] {
  const dirs: string[] = [];
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(root, entry.name, ...segments);
      if (existsSync(full)) dirs.push(full);
    }
  } catch {
    // best-effort: directory may not exist or be unreadable
  }
  return dirs;
}

function collectNvmFnmBins(home: string): string[] {
  return [
    ...existingDirsUnder(join(home, ".nvm", "versions", "node"), ["bin"]),
    ...existingDirsUnder(join(home, ".local", "share", "fnm", "node-versions"), ["installation", "bin"]),
    ...existingDirsUnder(join(home, ".local", "share", "mise", "installs", "node"), ["bin"]),
  ];
}

function resolvePackagedPathEnv(basePath = process.env.PATH ?? ""): string {
  const home = homedir();
  const candidates = [
    ...basePath.split(delimiter),
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    ...collectNvmFnmBins(home),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(candidates.filter((entry) => entry.length > 0))].join(delimiter);
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return PACKAGED_PROXY_ENV_ALLOWLIST.some((key) => {
    const value = env[key];
    return value != null && value.length > 0 && key.toUpperCase() !== "NO_PROXY";
  });
}

function hasNoProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    (env.NO_PROXY != null && env.NO_PROXY.length > 0) ||
    (env.no_proxy != null && env.no_proxy.length > 0)
  );
}

function appendNodeOption(existing: string | undefined, option: string): string {
  const parts = (existing ?? "").split(/\s+/).filter((part) => part.length > 0);
  if (parts.includes(option)) return parts.join(" ");
  return [...parts, option].join(" ");
}

function withDefaultNoProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!hasProxyEnv(env) || hasNoProxyEnv(env)) return env;
  return { ...env, NO_PROXY: DEFAULT_NO_PROXY };
}

function scutilValue(values: Record<string, string>, key: string): string | null {
  const value = values[key]?.trim();
  return value == null || value.length === 0 ? null : value;
}

function scutilProxyUrl(
  values: Record<string, string>,
  enableKey: string,
  hostKey: string,
  portKey: string,
  scheme: "http" | "socks5",
): string | null {
  if (scutilValue(values, enableKey) !== "1") return null;
  const host = scutilValue(values, hostKey);
  const port = scutilValue(values, portKey);
  if (host == null || port == null) return null;
  return `${scheme}://${host}:${port}`;
}

function parseMacSystemProxyEnv(stdout: string): NodeJS.ProcessEnv {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.*?)\s*$/);
    if (match == null) continue;
    values[match[1]] = match[2];
  }

  const httpProxy = scutilProxyUrl(values, "HTTPEnable", "HTTPProxy", "HTTPPort", "http");
  const httpsProxy =
    scutilProxyUrl(values, "HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http") ?? httpProxy;
  const socksProxy = scutilProxyUrl(values, "SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5");
  const proxyEnv: NodeJS.ProcessEnv = {};
  if (httpProxy != null) proxyEnv.HTTP_PROXY = httpProxy;
  if (httpsProxy != null) proxyEnv.HTTPS_PROXY = httpsProxy;
  if (socksProxy != null) proxyEnv.ALL_PROXY = socksProxy;
  return withDefaultNoProxy(proxyEnv);
}

async function resolveMacSystemProxyEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (platform() !== "darwin" || hasProxyEnv(env)) return {};
  try {
    const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 1500,
    });
    return parseMacSystemProxyEnv(stdout);
  } catch {
    return {};
  }
}

async function resolvePackagedChildBaseEnv(
  env: NodeJS.ProcessEnv = process.env,
  includeProviderSecrets = false,
): Promise<NodeJS.ProcessEnv> {
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value != null && value.length > 0 && shouldForwardPackagedChildEnv(key, includeProviderSecrets)) {
      baseEnv[key] = value;
    }
  }
  return withDefaultNoProxy({
    ...(await resolveMacSystemProxyEnv(env)),
    ...baseEnv,
  });
}

function resolvePackagedNodeOptionsEnv(
  nodeCommand: string | null,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (nodeCommand == null) return {};
  return {
    NODE_OPTIONS: appendNodeOption(baseEnv.NODE_OPTIONS, ENV_PROXY_NODE_OPTION),
  };
}

function createPackagedDaemonManagedPathEnv(
  paths: PackagedNamespacePaths,
): PackagedDaemonManagedPathEnv {
  return {
    OD_DATA_DIR: paths.dataRoot,
    OD_RESOURCE_ROOT: paths.resourceRoot,
  };
}

async function spawnSidecarChild(options: {
  app: AppKey;
  entryPath: string;
  env: NodeJS.ProcessEnv;
  nodeCommand: string | null;
  paths: PackagedNamespacePaths;
  runtime: SidecarRuntimeContext<SidecarStamp>;
}): Promise<ManagedSidecarChild> {
  const ipcPath = resolveAppIpcPath({
    app: options.app,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    namespace: options.runtime.namespace,
  });
  const stamp = {
    app: options.app,
    ipc: ipcPath,
    mode: SIDECAR_MODES.RUNTIME,
    namespace: options.runtime.namespace,
    source: options.runtime.source,
  } satisfies SidecarStamp;
  const logHandle = await openLog(logPathFor(options.paths, options.app));
  const childBaseEnv = await resolvePackagedChildBaseEnv(
    process.env,
    options.app === APP_KEYS.DAEMON,
  );
  const childEnv = createSidecarLaunchEnv({
    base: options.paths.runtimeRoot,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    extraEnv: {
      ...childBaseEnv,
      ...options.env,
      NODE_ENV: "production",
      ...resolvePackagedNodeOptionsEnv(options.nodeCommand, childBaseEnv),
      PATH: resolvePackagedPathEnv(),
      ...(options.nodeCommand == null ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    stamp,
  });
  const command = options.nodeCommand ?? process.execPath;
  const child = spawn(
    command,
    [options.entryPath, ...createProcessStampArgs(stamp, OPEN_DESIGN_SIDECAR_CONTRACT)],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      windowsHide: true,
    },
  );

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("error", rejectSpawn);
    child.once("spawn", resolveSpawn);
  });

  return { app: options.app, child, ipcPath, logHandle };
}

async function closeManagedChild(child: ManagedSidecarChild): Promise<void> {
  try {
    await requestJsonIpc(child.ipcPath, { type: SIDECAR_MESSAGES.SHUTDOWN }, { timeoutMs: 1200 });
  } catch {
    // Fall through to process cleanup.
  }

  if (!(await waitForProcessExit(child.child.pid, 5000))) {
    await stopProcesses([child.child.pid]);
  }

  await child.logHandle.close().catch(() => undefined);
}

export async function startPackagedSidecars(
  runtime: SidecarRuntimeContext<SidecarStamp>,
  paths: PackagedNamespacePaths,
  options: {
    appVersion: string | null;
    nodeCommand: string | null;
    webStandaloneRoot: string | null;
    webOutputMode: PackagedWebOutputMode;
  },
): Promise<PackagedSidecarHandle> {
  await mkdir(paths.namespaceRoot, { recursive: true });
  await mkdir(paths.cacheRoot, { recursive: true });
  await mkdir(paths.dataRoot, { recursive: true });
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(paths.desktopLogsRoot, { recursive: true });
  await mkdir(paths.runtimeRoot, { recursive: true });
  await mkdir(paths.electronUserDataRoot, { recursive: true });
  await mkdir(paths.electronSessionDataRoot, { recursive: true });

  const children: ManagedSidecarChild[] = [];

  try {
    const daemon = await spawnSidecarChild({
      app: APP_KEYS.DAEMON,
      entryPath: resolveSidecarEntry("@open-design/daemon", "sidecar"),
      env: {
        [SIDECAR_ENV.DAEMON_PORT]: "0",
        // Packaged daemon managed paths are deliberately delivered through
        // the sidecar launch environment. The daemon may keep its own default
        // fallback, but packaged runtime must not rely on path inference from
        // Electron userData, bundle names, or ports.
        ...createPackagedDaemonManagedPathEnv(paths),
        ...(options.appVersion == null ? {} : { OD_APP_VERSION: options.appVersion }),
      },
      nodeCommand: options.nodeCommand,
      paths,
      runtime,
    });
    children.push(daemon);
    const daemonStatus = await waitForStatus<DaemonStatusSnapshot>(
      daemon.ipcPath,
      (status) => status.url != null,
    );
    if (daemonStatus.url == null) throw new Error("daemon did not report a URL");

    const web = await spawnSidecarChild({
      app: APP_KEYS.WEB,
      entryPath: resolveSidecarEntry("@open-design/web", "sidecar"),
      env: {
        [SIDECAR_ENV.DAEMON_PORT]: extractPort(daemonStatus.url),
        [SIDECAR_ENV.WEB_PORT]: "0",
        ...(options.webStandaloneRoot == null ? {} : { OD_WEB_STANDALONE_ROOT: options.webStandaloneRoot }),
        OD_WEB_OUTPUT_MODE: options.webOutputMode,
        PORT: "0",
      },
      nodeCommand: options.nodeCommand,
      paths,
      runtime,
    });
    children.push(web);
    const webStatus = await waitForStatus<WebStatusSnapshot>(
      web.ipcPath,
      (status) => status.url != null,
    );
    if (webStatus.url == null) throw new Error("web did not report a URL");

    return {
      daemon: daemonStatus,
      web: webStatus,
      async close() {
        for (const child of [...children].reverse()) {
          await closeManagedChild(child).catch((error: unknown) => {
            console.error(`failed to close packaged ${child.app} sidecar`, error);
          });
        }
      },
    };
  } catch (error) {
    for (const child of [...children].reverse()) {
      await closeManagedChild(child).catch(() => undefined);
    }
    throw error;
  }
}
