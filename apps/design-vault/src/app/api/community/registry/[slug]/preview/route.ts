import { normalizeBaseUrl, readCommunityAuth } from "@/lib/auth-storage";

export const runtime = "nodejs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function placeholder(message: string) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;display:grid;place-items:center;height:100vh;font:13px ui-sans-serif;background:#faf9f7;color:#5b5854}@media(prefers-color-scheme:dark){body{background:#14130f;color:#a8a39a}}</style></head><body>${message}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!SLUG_RE.test(slug)) return placeholder("slug 非法");
  const auth = await readCommunityAuth();
  if (!auth?.baseUrl) return placeholder("未配置社区 server");
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? "card";
  const upstreamUrl = `${normalizeBaseUrl(auth.baseUrl)}/api/registry/${encodeURIComponent(slug)}/preview?kind=${encodeURIComponent(kind)}`;
  const upstream = await fetch(upstreamUrl, { cache: "no-store" }).catch(() => null);
  if (!upstream) return placeholder("无法连接社区 server");
  const html = await upstream.text();
  return new Response(html, {
    status: upstream.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=120",
    },
  });
}
