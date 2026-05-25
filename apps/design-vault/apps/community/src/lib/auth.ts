import { cookies } from "next/headers";

import { isAdmin } from "./env";
import { extractBearer, resolveSession } from "./sessions";
import type { PublisherRow } from "./db";

export const ADMIN_COOKIE = "dv_admin_session";

export type AuthContext = {
  publisher: PublisherRow;
  isAdmin: boolean;
};

export async function authFromRequest(request: Request): Promise<AuthContext | null> {
  // Bearer token (publisher API, used by local CLI/UI)
  const bearer = extractBearer(request);
  if (bearer) {
    const publisher = await resolveSession(bearer);
    if (publisher && !publisher.banned_at) {
      return { publisher, isAdmin: isAdmin({ login: publisher.github_login, id: Number(publisher.github_id) }) };
    }
  }

  // Admin cookie (web admin queue)
  const jar = await cookies();
  const cookieToken = jar.get(ADMIN_COOKIE)?.value;
  if (cookieToken) {
    const publisher = await resolveSession(cookieToken);
    if (publisher && !publisher.banned_at) {
      return { publisher, isAdmin: isAdmin({ login: publisher.github_login, id: Number(publisher.github_id) }) };
    }
  }
  return null;
}

export async function adminAuthFromRequest(request: Request): Promise<AuthContext | null> {
  const ctx = await authFromRequest(request);
  return ctx?.isAdmin ? ctx : null;
}
