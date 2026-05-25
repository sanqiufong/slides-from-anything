import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_COMMUNITY_BASE_URL = "https://vault.aassistant.xyz";

function authDir() {
  const configured = process.env.DESIGN_VAULT_COMMUNITY_AUTH_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), ".local", "community-auth");
}

function authFile() {
  return path.join(authDir(), "auth.json");
}

export type CommunityAuthState = {
  baseUrl: string;
  token?: string;
  login?: string;
  displayName?: string;
  isAdmin?: boolean;
  savedAt?: string;
};

function configuredCommunityBaseUrl(): string | null {
  const configured =
    process.env.DESIGN_VAULT_COMMUNITY_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_DESIGN_VAULT_COMMUNITY_BASE_URL?.trim() ||
    DEFAULT_COMMUNITY_BASE_URL;
  return configured ? normalizeBaseUrl(configured) : null;
}

function fallbackCommunityAuth(): CommunityAuthState | null {
  const baseUrl = configuredCommunityBaseUrl();
  return baseUrl ? { baseUrl } : null;
}

export async function readCommunityAuth(): Promise<CommunityAuthState | null> {
  try {
    const raw = await readFile(authFile(), "utf8");
    const parsed = JSON.parse(raw) as CommunityAuthState;
    if (typeof parsed.baseUrl !== "string" || !parsed.baseUrl) return fallbackCommunityAuth();
    return parsed;
  } catch {
    return fallbackCommunityAuth();
  }
}

export async function writeCommunityAuth(state: CommunityAuthState): Promise<CommunityAuthState> {
  const filePath = authFile();
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: CommunityAuthState = { ...state, savedAt: new Date().toISOString() };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
  return payload;
}

export async function clearCommunityToken(): Promise<CommunityAuthState | null> {
  const current = await readCommunityAuth();
  if (!current) return null;
  const next: CommunityAuthState = {
    baseUrl: current.baseUrl,
    savedAt: new Date().toISOString(),
  };
  await writeCommunityAuth(next);
  return next;
}

export async function authFileExists(): Promise<boolean> {
  try {
    await stat(authFile());
    return true;
  } catch {
    return false;
  }
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
