import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppVersionInfo } from './app-version.js';

export interface AppUpdateAsset {
  url: string;
  sha256?: string;
  size?: number;
}

export interface AppUpdateManifest {
  version: string;
  channel?: string;
  minimumVersion?: string;
  releasedAt?: string;
  notes?: string;
  notesUrl?: string;
  releaseUrl?: string;
  assets?: Record<string, AppUpdateAsset>;
}

export type AppUpdateStatus = 'disabled' | 'latest' | 'available' | 'error';

export interface AppUpdateCheckResponse {
  current: AppVersionInfo;
  status: AppUpdateStatus;
  checkedAt: string;
  sourceMode: 'source' | 'packaged';
  latestVersion?: string;
  platformKey?: string;
  manifestUrl?: string;
  asset?: AppUpdateAsset | null;
  notes?: string;
  notesUrl?: string;
  releaseUrl?: string;
  error?: string;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal | undefined },
) => Promise<FetchResponseLike>;

export interface CheckForAppUpdatesOptions {
  env?: NodeJS.ProcessEnv | undefined;
  now?: Date | undefined;
  manifestUrl?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

interface ManifestLocation {
  url: string;
  displayUrl: string;
  configured: boolean;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_LOCAL_MANIFEST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'releases',
  'stable.json',
);

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isTruthyFlag(value: string | null): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseSemver(version: string): ParsedSemver | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return a.localeCompare(b);

  for (const key of ['major', 'minor', 'patch'] as const) {
    const delta = left[key] - right[key];
    if (delta !== 0) return delta;
  }

  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

export function updatePlatformKey(current: Pick<AppVersionInfo, 'platform' | 'arch'>): string {
  const { platform, arch } = current;
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  return `${platform}-${arch}`;
}

function resolveManifestLocation(
  current: AppVersionInfo,
  { env = process.env, manifestUrl }: Pick<CheckForAppUpdatesOptions, 'env' | 'manifestUrl'> = {},
): ManifestLocation | null {
  if (
    isTruthyFlag(cleanString(env.SFA_UPDATE_DISABLED))
    || isTruthyFlag(cleanString(env.OD_UPDATE_DISABLED))
  ) {
    return null;
  }

  const configured = cleanString(manifestUrl)
    ?? cleanString(env.SFA_UPDATE_MANIFEST_URL)
    ?? cleanString(env.OD_UPDATE_MANIFEST_URL);
  if (configured) {
    return { url: configured, displayUrl: configured, configured: true };
  }

  if (!existsSync(DEFAULT_LOCAL_MANIFEST)) return null;
  return {
    url: DEFAULT_LOCAL_MANIFEST,
    displayUrl: `local:releases/stable.json#${current.channel}`,
    configured: false,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function filePathFromUrlOrPath(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'file:') return fileURLToPath(parsed);
  } catch {
    // Treat non-URL values as file paths.
  }
  return path.resolve(value);
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchTextWithTimeout(
  url: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): Promise<string> {
  const timeoutMs = parsePositiveInteger(
    cleanString(env.SFA_UPDATE_TIMEOUT_MS) ?? cleanString(env.OD_UPDATE_TIMEOUT_MS),
    DEFAULT_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`update manifest request failed with HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const next = value[key];
  return typeof next === 'string' && next.trim().length > 0 ? next.trim() : undefined;
}

function readAsset(value: unknown): AppUpdateAsset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const url = readString(record, 'url');
  if (!url) return null;
  const asset: AppUpdateAsset = { url };
  const sha256 = readString(record, 'sha256');
  if (sha256) asset.sha256 = sha256;
  if (typeof record.size === 'number' && Number.isFinite(record.size) && record.size > 0) {
    asset.size = record.size;
  }
  return asset;
}

function normalizeManifest(raw: unknown): AppUpdateManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('update manifest must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  const version = readString(record, 'version');
  if (!version) throw new Error('update manifest is missing version');

  const manifest: AppUpdateManifest = { version };
  for (const key of ['channel', 'minimumVersion', 'releasedAt', 'notes', 'notesUrl', 'releaseUrl'] as const) {
    const value = readString(record, key);
    if (value) manifest[key] = value;
  }

  if (record.assets && typeof record.assets === 'object' && !Array.isArray(record.assets)) {
    const assets: Record<string, AppUpdateAsset> = {};
    for (const [key, value] of Object.entries(record.assets as Record<string, unknown>)) {
      const asset = readAsset(value);
      if (asset) assets[key] = asset;
    }
    if (Object.keys(assets).length > 0) manifest.assets = assets;
  }

  return manifest;
}

async function readUpdateManifest(
  location: ManifestLocation,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): Promise<AppUpdateManifest> {
  const rawText = isHttpUrl(location.url)
    ? await fetchTextWithTimeout(location.url, env, fetchImpl)
    : await readFile(filePathFromUrlOrPath(location.url), 'utf8');
  return normalizeManifest(JSON.parse(rawText));
}

function selectAsset(
  manifest: AppUpdateManifest,
  current: AppVersionInfo,
  platformKey: string,
): AppUpdateAsset | null {
  const assets = manifest.assets;
  if (!assets) return null;
  return assets[platformKey]
    ?? assets[`${current.platform}-${current.arch}`]
    ?? assets[current.platform]
    ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'update check failed';
}

export async function checkForAppUpdates(
  current: AppVersionInfo,
  options: CheckForAppUpdatesOptions = {},
): Promise<AppUpdateCheckResponse> {
  const env = options.env ?? process.env;
  const checkedAt = (options.now ?? new Date()).toISOString();
  const sourceMode = current.packaged ? 'packaged' : 'source';
  const location = resolveManifestLocation(current, options);
  const base = { current, checkedAt, sourceMode } satisfies Pick<
    AppUpdateCheckResponse,
    'current' | 'checkedAt' | 'sourceMode'
  >;

  if (!location) {
    return { ...base, status: 'disabled' };
  }

  try {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const manifest = await readUpdateManifest(location, env, fetchImpl as FetchLike);
    const platformKey = updatePlatformKey(current);
    const asset = selectAsset(manifest, current, platformKey);
    const status = compareSemver(manifest.version, current.version) > 0 ? 'available' : 'latest';
    return {
      ...base,
      status,
      latestVersion: manifest.version,
      platformKey,
      manifestUrl: location.displayUrl,
      asset,
      ...(manifest.notes ? { notes: manifest.notes } : {}),
      ...(manifest.notesUrl ? { notesUrl: manifest.notesUrl } : {}),
      ...(manifest.releaseUrl ? { releaseUrl: manifest.releaseUrl } : {}),
    };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      manifestUrl: location.displayUrl,
      error: errorMessage(error),
    };
  }
}
