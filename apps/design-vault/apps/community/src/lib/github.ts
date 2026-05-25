import { env } from "./env";
import { sql, type PublisherRow } from "./db";

export type GithubDeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

export type GithubAccessToken = {
  access_token: string;
  token_type: string;
  scope: string;
};

export type GithubDevicePollResult =
  | { state: "ok"; accessToken: string }
  | { state: "pending" }
  | { state: "slow_down"; interval: number }
  | { state: "expired" }
  | { state: "denied" }
  | { state: "error"; message: string };

export type GithubUser = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
};

const GITHUB_API = "https://api.github.com";

export async function startDeviceFlow(): Promise<GithubDeviceStart> {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.githubClientId,
      scope: "read:user user:email",
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub device flow start failed: ${response.status}`);
  }
  return (await response.json()) as GithubDeviceStart;
}

export async function pollDeviceFlow(deviceCode: string): Promise<GithubDevicePollResult> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.githubClientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (!response.ok) {
    return { state: "error", message: `HTTP ${response.status}` };
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.access_token === "string") {
    return { state: "ok", accessToken: data.access_token };
  }
  const error = typeof data.error === "string" ? data.error : "unknown";
  switch (error) {
    case "authorization_pending":
      return { state: "pending" };
    case "slow_down":
      return { state: "slow_down", interval: Number(data.interval) || 10 };
    case "expired_token":
      return { state: "expired" };
    case "access_denied":
      return { state: "denied" };
    default:
      return { state: "error", message: String(data.error_description ?? error) };
  }
}

export async function exchangeWebCode(code: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.githubClientId,
      client_secret: env.githubClientSecret,
      code,
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub code exchange failed: ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.access_token !== "string") {
    throw new Error(`GitHub code exchange missing access_token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

export async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const response = await fetch(`${GITHUB_API}/user`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "design-vault-community",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub /user failed: ${response.status}`);
  }
  return (await response.json()) as GithubUser;
}

export async function upsertPublisher(user: GithubUser): Promise<PublisherRow> {
  const rows = await sql<PublisherRow[]>`
    insert into community.publishers (github_login, github_id, email, display_name)
    values (${user.login}, ${user.id}, ${user.email ?? null}, ${user.name ?? null})
    on conflict (github_id) do update
      set github_login = excluded.github_login,
          email = coalesce(excluded.email, community.publishers.email),
          display_name = coalesce(excluded.display_name, community.publishers.display_name)
    returning *
  `;
  return rows[0];
}
