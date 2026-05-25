import { createHash, randomBytes } from "node:crypto";

import { sql, type PublisherRow } from "./db";

const SESSION_TTL_DAYS = 30;

export type SessionContext = {
  token: string;
  publisher: PublisherRow;
  isAdmin: boolean;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function issueSession(publisherId: string, userAgent: string | null): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hashed = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await sql`
    insert into community.sessions (token_sha256, publisher_id, expires_at, user_agent)
    values (${hashed}, ${publisherId}, ${expiresAt}, ${userAgent ?? null})
  `;
  return token;
}

export async function revokeSession(token: string): Promise<void> {
  await sql`delete from community.sessions where token_sha256 = ${sha256(token)}`;
}

export async function resolveSession(token: string | null): Promise<PublisherRow | null> {
  if (!token) return null;
  const hashed = sha256(token);
  const rows = await sql<PublisherRow[]>`
    update community.sessions
    set last_used_at = now()
    where token_sha256 = ${hashed} and expires_at > now()
    returning publisher_id
  `;
  if (!rows.length) return null;
  const publisherId = (rows[0] as unknown as { publisher_id: string }).publisher_id;
  const publishers = await sql<PublisherRow[]>`
    select * from community.publishers where id = ${publisherId}
  `;
  return publishers[0] ?? null;
}

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match ? match[1] : null;
}
