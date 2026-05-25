import { readCommunityAuth, normalizeBaseUrl, type CommunityAuthState } from "./auth-storage";

export type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

export type DevicePollResult =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "ok"; token: string; login: string; displayName?: string; isAdmin: boolean }
  | { status: "error"; error: string };

export type RegistryEntry = {
  slug: string;
  title: string;
  summary: string;
  archetype?: string;
  qualityScore?: number;
  qualityGrade?: string;
  tags: string[];
  publisher: { login: string; displayName?: string };
  bundleBytes: number;
  bundleSha256: string;
  bundleFormat: number;
  bundleUrl: string;
  updatedAt: string;
  publishedAt: string;
  downloads: number;
  manifest: { sourceHost: string; sourceMode: string; license: string };
};

async function ensureAuth(): Promise<CommunityAuthState> {
  const auth = await readCommunityAuth();
  if (!auth) throw new Error("尚未设置社区服务地址。先在 /community 页面登录并保存 server URL。");
  return auth;
}

function authHeaders(auth: CommunityAuthState): HeadersInit {
  return auth.token ? { authorization: `Bearer ${auth.token}` } : {};
}

export async function startDeviceLogin(baseUrl: string): Promise<DeviceStart> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/auth/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `device/start failed (${response.status})`);
  }
  return (await response.json()) as DeviceStart;
}

export async function pollDeviceLogin(baseUrl: string, deviceCode: string): Promise<DevicePollResult> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/auth/device/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status === 202) {
    const status = typeof payload?.status === "string" ? payload.status : "pending";
    if (status === "slow_down" && typeof payload?.interval === "number") {
      return { status: "slow_down", interval: payload.interval };
    }
    return { status: "pending" };
  }
  if (response.ok && payload && payload.status === "ok") {
    return {
      status: "ok",
      token: String(payload.token),
      login: String(payload.login),
      displayName: typeof payload.displayName === "string" ? payload.displayName : undefined,
      isAdmin: Boolean(payload.isAdmin),
    };
  }
  return { status: "error", error: payload && typeof payload.error === "string" ? payload.error : `poll failed (${response.status})` };
}

export async function logoutCommunity(): Promise<void> {
  const auth = await readCommunityAuth();
  if (!auth?.token) return;
  await fetch(`${normalizeBaseUrl(auth.baseUrl)}/api/auth/logout`, {
    method: "POST",
    headers: authHeaders(auth),
  }).catch(() => undefined);
}

export async function fetchRegistry(filters: { tag?: string; q?: string } = {}): Promise<RegistryEntry[]> {
  const auth = await ensureAuth();
  const url = new URL(`${normalizeBaseUrl(auth.baseUrl)}/api/registry`);
  if (filters.tag) url.searchParams.set("tag", filters.tag);
  if (filters.q) url.searchParams.set("q", filters.q);
  const response = await fetch(url, { headers: authHeaders(auth), cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `registry fetch failed (${response.status})`);
  }
  const data = (await response.json()) as { designs?: RegistryEntry[] };
  return Array.isArray(data.designs) ? data.designs : [];
}

export type MySubmission = {
  id: string;
  slug: string;
  title: string;
  status: "pending" | "approved" | "rejected" | "superseded" | "retracted";
  qualityScore: number | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewNotes: string | null;
};

export async function fetchMySubmissions(): Promise<MySubmission[]> {
  const auth = await readCommunityAuth();
  if (!auth?.token) return [];
  const response = await fetch(`${normalizeBaseUrl(auth.baseUrl)}/api/submissions/mine`, {
    headers: authHeaders(auth),
    cache: "no-store",
  });
  if (response.status === 401) return [];
  if (!response.ok) {
    return [];
  }
  const data = (await response.json()) as MySubmission[];
  return Array.isArray(data) ? data : [];
}

export async function fetchRegistryEntry(slug: string): Promise<RegistryEntry | null> {
  const auth = await ensureAuth();
  const response = await fetch(`${normalizeBaseUrl(auth.baseUrl)}/api/registry/${encodeURIComponent(slug)}`, {
    headers: authHeaders(auth),
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `registry fetch failed (${response.status})`);
  }
  return (await response.json()) as RegistryEntry;
}

export async function downloadRegistryBundle(slug: string): Promise<Buffer> {
  const auth = await ensureAuth();
  const response = await fetch(`${normalizeBaseUrl(auth.baseUrl)}/api/registry/${encodeURIComponent(slug)}/bundle`, {
    headers: authHeaders(auth),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `bundle download failed (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function uploadBundle(bundleBuffer: Buffer, filename: string): Promise<{ submissionId: string; status: string }> {
  const auth = await ensureAuth();
  if (!auth.token) throw new Error("尚未登录社区服务。");
  const formData = new FormData();
  formData.append("bundle", new Blob([new Uint8Array(bundleBuffer)], { type: "application/gzip" }), filename);
  const response = await fetch(`${normalizeBaseUrl(auth.baseUrl)}/api/submissions`, {
    method: "POST",
    headers: authHeaders(auth),
    body: formData,
  });
  const payload = (await response.json().catch(() => null)) as
    | { submissionId?: string; status?: string; error?: string }
    | null;
  if (!response.ok || !payload?.submissionId) {
    throw new Error(payload?.error || `submission failed (${response.status})`);
  }
  return { submissionId: payload.submissionId, status: payload.status ?? "pending" };
}
