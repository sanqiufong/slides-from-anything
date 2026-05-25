import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { ADMIN_COOKIE } from "@/lib/auth";
import { consumeCliState, isCliState } from "@/lib/cli-state";
import { env, isAdmin } from "@/lib/env";
import { exchangeWebCode, fetchGithubUser, upsertPublisher } from "@/lib/github";
import { issueSession } from "@/lib/sessions";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) {
    return NextResponse.json({ error: "Missing code parameter." }, { status: 400 });
  }
  try {
    const accessToken = await exchangeWebCode(code);
    const githubUser = await fetchGithubUser(accessToken);
    const publisher = await upsertPublisher(githubUser);
    if (publisher.banned_at) {
      return NextResponse.json({ error: "Account banned." }, { status: 403 });
    }
    const token = await issueSession(publisher.id, request.headers.get("user-agent"));
    const admin = isAdmin({ login: publisher.github_login, id: Number(publisher.github_id) });

    // CLI flow: state was minted via /api/auth/cli with a localhost return URL.
    // Send the token back to the local app instead of setting our own cookie.
    if (isCliState(state)) {
      const ctx = consumeCliState(state!);
      if (!ctx) {
        return NextResponse.json({ error: "登录请求已过期（10 分钟），请回到本地重试。" }, { status: 410 });
      }
      const redirect = new URL(ctx.returnUrl);
      redirect.searchParams.set("token", token);
      redirect.searchParams.set("login", publisher.github_login);
      if (publisher.display_name) redirect.searchParams.set("displayName", publisher.display_name);
      redirect.searchParams.set("isAdmin", admin ? "1" : "0");
      return NextResponse.redirect(redirect.toString(), 302);
    }

    // Web admin flow: set cookie, send to /admin.
    const jar = await cookies();
    jar.set(ADMIN_COOKIE, token, {
      httpOnly: true,
      secure: env.publicBaseUrl.startsWith("https://"),
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return NextResponse.redirect(new URL("/admin", env.publicBaseUrl));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "OAuth callback failed." },
      { status: 502 },
    );
  }
}
