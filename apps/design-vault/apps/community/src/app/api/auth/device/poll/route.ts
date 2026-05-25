import { NextResponse } from "next/server";

import { fetchGithubUser, pollDeviceFlow, upsertPublisher } from "@/lib/github";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { isAdmin } from "@/lib/env";
import { issueSession } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limit = rateLimit(clientKey(request, "device-poll"), 120, 60);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Polling too frequently." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }
  const body = (await request.json().catch(() => null)) as { device_code?: string } | null;
  if (!body || typeof body.device_code !== "string" || !body.device_code) {
    return NextResponse.json({ error: "Missing device_code." }, { status: 400 });
  }
  const result = await pollDeviceFlow(body.device_code);
  switch (result.state) {
    case "pending":
      return NextResponse.json({ status: "pending" }, { status: 202 });
    case "slow_down":
      return NextResponse.json({ status: "slow_down", interval: result.interval }, { status: 202 });
    case "denied":
      return NextResponse.json({ error: "用户拒绝了授权。" }, { status: 401 });
    case "expired":
      return NextResponse.json({ error: "设备码已过期，请重新发起登录。" }, { status: 410 });
    case "error":
      return NextResponse.json({ error: result.message }, { status: 502 });
    case "ok": {
      try {
        const githubUser = await fetchGithubUser(result.accessToken);
        const publisher = await upsertPublisher(githubUser);
        if (publisher.banned_at) {
          return NextResponse.json({ error: "该账号已被封禁。" }, { status: 403 });
        }
        const token = await issueSession(publisher.id, request.headers.get("user-agent"));
        return NextResponse.json(
          {
            status: "ok",
            token,
            login: publisher.github_login,
            displayName: publisher.display_name,
            isAdmin: isAdmin({ login: publisher.github_login, id: Number(publisher.github_id) }),
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "登录处理失败。" },
          { status: 502 },
        );
      }
    }
  }
}
