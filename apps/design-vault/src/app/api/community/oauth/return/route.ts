import { readCommunityAuth, writeCommunityAuth } from "@/lib/auth-storage";

export const runtime = "nodejs";

function htmlPage(body: string) {
  return new Response(
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Design Vault · 登录</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif; max-width: 480px; margin: 80px auto; padding: 32px; line-height: 1.6; color: #1a1917; background: #faf9f7; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
    h1 { font-family: "Source Serif 4", serif; font-size: 22px; margin: 0 0 12px; }
    p { color: #5b5854; margin: 8px 0; }
    .tag { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #f7e9e1; color: #b6502d; font-weight: 600; font-size: 13px; }
    @media (prefers-color-scheme: dark) { body { background: #14130f; color: #f7f5ef; box-shadow: 0 2px 12px rgba(0,0,0,.5); } p { color: #a8a39a; } .tag { background: #2c1c14; color: #e08658; } }
  </style>
</head>
<body>${body}</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const login = url.searchParams.get("login");
  const displayName = url.searchParams.get("displayName") || undefined;
  const isAdmin = url.searchParams.get("isAdmin") === "1";
  const errorMsg = url.searchParams.get("error");

  if (errorMsg) {
    return htmlPage(`<h1>登录被中断</h1><p>${escapeHtml(errorMsg)}</p><p>关掉这个窗口回到资料库重试即可。</p>`);
  }
  if (!token || !login) {
    return htmlPage(`<h1>登录失败</h1><p>缺少 token 或 login 参数。这是 OAuth 流程异常，关掉窗口重试一次；多次失败请联系管理员。</p>`);
  }

  const existing = await readCommunityAuth();
  if (!existing?.baseUrl) {
    return htmlPage(`<h1>未配置 server URL</h1><p>本地资料库还没保存社区服务地址。先去本地 /community 页设好 baseUrl 再登录。</p>`);
  }

  await writeCommunityAuth({
    baseUrl: existing.baseUrl,
    token,
    login,
    displayName,
    isAdmin,
  });

  return htmlPage(
    `<h1>✓ 已登录</h1>
     <p>身份：<span class="tag">@${escapeHtml(login)}</span>${isAdmin ? '<span class="tag" style="margin-left:6px;background:#dfeed8;color:#2f7a3a">admin</span>' : ""}</p>
     <p>这个窗口可以关掉了。回到本地资料库，你会看到顶上身份徽章变绿，卡片右上角的 🚀 发布按钮已激活。</p>
     <script>setTimeout(function(){ try { window.close(); } catch (e) {} }, 1500);</script>`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}
