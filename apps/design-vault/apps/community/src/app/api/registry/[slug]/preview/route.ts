import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { extractPreviewHtml, type PreviewKind } from "@/lib/preview-extract";
import { getRegistryRow } from "@/lib/registry";

export const runtime = "nodejs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const VALID_KINDS: PreviewKind[] = ["card", "web", "ppt", "style"];

function placeholderHtml(message: string) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>预览不可用</title>
<style>body{margin:0;display:grid;place-items:center;height:100vh;font:13px/1.5 ui-sans-serif,system-ui;background:#faf9f7;color:#5b5854}.card{padding:24px;border:1px dashed #d8d4cc;border-radius:10px;max-width:380px;text-align:center}@media(prefers-color-scheme:dark){body{background:#14130f;color:#a8a39a}.card{border-color:#2a2722}}</style>
</head><body><div class="card">${message}</div></body></html>`;
}

function injectBase(html: string, baseHref: string): string {
  const tag = `<base href="${baseHref}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}${tag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (match) => `${match}<head>${tag}</head>`);
  }
  return `<head>${tag}</head>${html}`;
}

/**
 * Bundles ship preview HTML that references assets via absolute paths shaped
 * like `/api/designs/<slug>/asset/<path>` — those routes live on the LOCAL
 * design-vault dev server, not on the community server. Rewrite each such
 * URL to the community server's file route so assets actually load when the
 * preview is iframed from /admin or /community.
 */
function rewriteLocalAssetUrls(html: string, slug: string): string {
  return html.replace(/\/api\/designs\/[a-z0-9][a-z0-9-]*\/asset\//g, `/api/registry/${slug}/file/assets/`);
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "Invalid slug." }, { status: 400 });
  const url = new URL(request.url);
  const kindParam = (url.searchParams.get("kind") ?? "card") as PreviewKind;
  const kind: PreviewKind = VALID_KINDS.includes(kindParam) ? kindParam : "card";

  const row = await getRegistryRow(slug);
  if (!row) {
    return new NextResponse(placeholderHtml("该设计不在已审核列表里。"), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const html = await extractPreviewHtml(row.submission.bundle_path, row.submission.bundle_sha256, kind);
  if (!html) {
    return new NextResponse(placeholderHtml(`Bundle 内无 ${kind} 预览。`), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  }
  // Anchor bundle-root-relative URLs (`assets/foo.png` form emitted by the
  // generator) to the file route at the bundle root. This is uniform whether
  // the HTML lives at `STYLE_CARD.html` (root) or `previews/card.html` —
  // bundle-relative URLs always resolve from the same anchor.
  const baseHref = `${env.publicBaseUrl}/api/registry/${encodeURIComponent(slug)}/file/`;
  const rewritten = rewriteLocalAssetUrls(injectBase(html, baseHref), slug);
  return new NextResponse(rewritten, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-design-vault-preview": kind,
    },
  });
}
