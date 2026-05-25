import { NextResponse } from "next/server";

import { adminAuthFromRequest } from "@/lib/auth";
import { sql, type SubmissionRow } from "@/lib/db";
import { env } from "@/lib/env";
import { extractPreviewHtml, type PreviewKind } from "@/lib/preview-extract";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/** Rewrite local-dev absolute asset URLs to the admin file route. */
function rewriteLocalAssetUrls(html: string, id: string): string {
  return html.replace(/\/api\/designs\/[a-z0-9][a-z0-9-]*\/asset\//g, `/api/admin/submissions/${id}/file/assets/`);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await adminAuthFromRequest(request);
  if (!ctx) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const { id } = await context.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  const url = new URL(request.url);
  const kindParam = (url.searchParams.get("kind") ?? "card") as PreviewKind;
  const kind: PreviewKind = VALID_KINDS.includes(kindParam) ? kindParam : "card";

  const rows = await sql<SubmissionRow[]>`select * from community.submissions where id = ${id}`;
  const submission = rows[0];
  if (!submission) {
    return new NextResponse(placeholderHtml("找不到这条提交。"), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const html = await extractPreviewHtml(submission.bundle_path, submission.bundle_sha256, kind);
  if (!html) {
    return new NextResponse(placeholderHtml(`Bundle 内无 ${kind} 预览。`), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const baseHref = `${env.publicBaseUrl}/api/admin/submissions/${id}/file/`;
  const rewritten = rewriteLocalAssetUrls(injectBase(html, baseHref), id);
  return new NextResponse(rewritten, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
