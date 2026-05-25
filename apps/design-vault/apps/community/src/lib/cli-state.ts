import { randomBytes } from "node:crypto";

type CliState = { returnUrl: string; createdAt: number };

const TEN_MINUTES = 10 * 60 * 1000;
const states = new Map<string, CliState>();

function gc() {
  const now = Date.now();
  for (const [key, value] of states) {
    if (now - value.createdAt > TEN_MINUTES) states.delete(key);
  }
}

export function createCliState(returnUrl: string): string {
  gc();
  const state = `cli-${randomBytes(16).toString("base64url")}`;
  states.set(state, { returnUrl, createdAt: Date.now() });
  return state;
}

export function consumeCliState(state: string): CliState | null {
  gc();
  const ctx = states.get(state);
  if (!ctx) return null;
  states.delete(state);
  return ctx;
}

export function isCliState(state: string | null | undefined): boolean {
  return typeof state === "string" && state.startsWith("cli-");
}
