import { NextResponse } from "next/server";

import { createCliState } from "@/lib/cli-state";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnRaw = url.searchParams.get("return");
  if (!returnRaw) {
    return NextResponse.json({ error: "Missing return parameter." }, { status: 400 });
  }
  let parsedReturn: URL;
  try {
    parsedReturn = new URL(returnRaw);
  } catch {
    return NextResponse.json({ error: "Invalid return URL." }, { status: 400 });
  }
  if (parsedReturn.protocol !== "http:" || !LOCAL_HOSTS.has(parsedReturn.hostname)) {
    return NextResponse.json(
      { error: "Return URL must be http://localhost or http://127.0.0.1." },
      { status: 400 },
    );
  }

  const state = createCliState(parsedReturn.toString());
  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.githubClientId);
  githubUrl.searchParams.set("redirect_uri", `${env.publicBaseUrl}/api/auth/github/callback`);
  githubUrl.searchParams.set("scope", "read:user user:email");
  githubUrl.searchParams.set("state", state);
  return NextResponse.redirect(githubUrl.toString(), 302);
}
