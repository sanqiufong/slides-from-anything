function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function commaList(name: string): string[] {
  const raw = optional(name);
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  publicBaseUrl: required("PUBLIC_BASE_URL").replace(/\/$/, ""),
  bundleStorageRoot: required("BUNDLE_STORAGE_ROOT"),
  githubClientId: required("GITHUB_CLIENT_ID"),
  githubClientSecret: required("GITHUB_CLIENT_SECRET"),
  // login is convenient but rename-hijackable. Prefer ADMIN_GITHUB_IDS.
  adminGithubLogins: commaList("ADMIN_GITHUB_LOGINS"),
  // GitHub numeric user IDs are immutable. When set, login is ignored for admin
  // checks — defends against the "user X renames or deletes account, attacker
  // re-registers that username and inherits admin" attack path.
  adminGithubIds: commaList("ADMIN_GITHUB_IDS").map((entry) => entry.trim()).filter((entry) => /^\d+$/.test(entry)),
};

if (env.adminGithubIds.length === 0 && env.adminGithubLogins.length > 0) {
  // Loud warning so an operator never silently runs in the weaker mode.
  console.warn(
    `[design-vault] WARNING: ADMIN_GITHUB_IDS is unset; admin auth falls back to ADMIN_GITHUB_LOGINS (login string match). ` +
      `This is vulnerable to GitHub username rename / account-deletion hijacks. ` +
      `Set ADMIN_GITHUB_IDS=<comma-separated-numeric-ids> to harden.`,
  );
}

export function isAdmin(user: { login?: string | null; id?: number | null } | null | undefined): boolean {
  if (!user) return false;
  // Strict mode: if any IDs are configured, admin is bound to immutable user IDs.
  if (env.adminGithubIds.length > 0) {
    if (typeof user.id !== "number" || !Number.isFinite(user.id)) return false;
    return env.adminGithubIds.includes(String(user.id));
  }
  // Fallback mode (logged a warning at startup): login string match.
  if (!user.login || env.adminGithubLogins.length === 0) return false;
  const lower = user.login.toLowerCase();
  return env.adminGithubLogins.some((entry) => entry.toLowerCase() === lower);
}
