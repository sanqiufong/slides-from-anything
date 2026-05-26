import { NextResponse } from "next/server";

import { normalizeHtmlPreview } from "@/lib/html-preview";
import { renderCardPreview, renderPptPreview, renderWebPreview } from "@/lib/preview";
import { getDesign, previewPath, readText } from "@/lib/storage";
import { compileTokenStylesheet } from "@/lib/token-stylesheet";
import type { DesignMeta } from "@/lib/types";

/**
 * Splice the W1.3/W1.4 token stylesheet into a preview HTML at serve
 * time. Existing previews on disk (60+ designs) were generated before
 * the token pipeline existed, so they have no `--dv-*` vars. Injecting
 * here means every served iframe gets the variables without a costly
 * regenerate-design-docs run; new previews (which already include the
 * stylesheet from the renderer) get a harmless second copy, which CSS
 * cascade resolves correctly.
 */
/**
 * Anchor bundle-root-relative URLs (e.g. `assets/foo.png` emitted by
 * preview.ts / card-preview.ts) to the local file route. Inserts as the
 * FIRST child of `<head>` so it precedes any `<link>` / `<style>` siblings.
 * Absolute `/api/designs/<slug>/asset/...` URLs are rewritten separately below
 * because `<base>` only governs relative refs.
 */
function injectBundleBase(html: string, slug: string): string {
  const tag = `<base href="/api/designs/${slug}/file/">`;
  if (/<base\b/i.test(html)) return html; // honor an existing base if present
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}${tag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  }
  return `<head>${tag}</head>${html}`;
}

function rewriteDesignAssetUrls(html: string, slug: string): string {
  return html.replace(/(["'(=])\/api\/designs\/([a-z0-9][a-z0-9-]*)\/asset\//g, (match, prefix: string, embeddedSlug: string) => {
    if (embeddedSlug === slug) return match;
    return `${prefix}/api/designs/${slug}/asset/`;
  });
}

function injectTokensIntoHtml(html: string, design: DesignMeta): string {
  if (!design.profile) return html;
  const styleBlock = compileTokenStylesheet(design.profile);
  // Skip if the stylesheet was already injected — match the comment we
  // emit in the compiler output (the `<style>\n:root {` opener is
  // stable enough to recognise).
  if (html.includes("--dv-color-") && html.includes("--dv-bg:")) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${styleBlock}\n</head>`);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${styleBlock}`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}\n${styleBlock}`);
  return `${styleBlock}\n${html}`;
}

function hasLocalizedCanvaPreview(design: DesignMeta) {
  if (design.sourceMode !== "canva-template" && design.sourceMode !== "canva-editor") return false;
  return design.assets.some((asset) => (asset.kind === "image" || asset.kind === "svg") && !asset.path.includes("style-source.svg") && !/fallback|generated/i.test(asset.name));
}

const PPT_SLIDES = new Set(["title", "data", "image", "single", "multi"]);

function isPptPreviewLayoutCompatible(html: string) {
  if (!/class\s*=\s*["'][^"']*\bdv-ppt-slide\b/i.test(html)) return false;
  for (const slide of PPT_SLIDES) {
    if (!new RegExp(`data-slide\\s*=\\s*["']${slide}["']`, "i").test(html)) return false;
  }
  return /width\s*:\s*1120px/i.test(html) &&
    /height\s*:\s*630px/i.test(html) &&
    /overflow(?:-x|-y)?\s*:\s*(?:hidden|clip)/i.test(html) &&
    /prefers-reduced-motion\s*:\s*reduce/i.test(html);
}

function withBodyClass(html: string, className: string) {
  return html.replace(/<body\b([^>]*)>/i, (match, attrs: string) => {
    if (/class\s*=/i.test(attrs)) {
      return `<body${attrs.replace(/class\s*=\s*(["'])(.*?)\1/i, (_classMatch, quote: string, value: string) => `class=${quote}${value} ${className}${quote}`)}>`;
    }
    return `<body${attrs} class="${className}">`;
  });
}

function focusPptSlide(html: string, slide: string | null) {
  if (!slide || !PPT_SLIDES.has(slide)) return html;
  const style = `<style id="dv-ppt-single-preview">html,body.dv-single-ppt-preview{width:1120px!important;height:630px!important;overflow:hidden!important;background:transparent!important}body.dv-single-ppt-preview *{box-sizing:border-box}body.dv-single-ppt-preview main{width:1120px!important;height:630px!important;min-height:0!important;padding:0!important;margin:0!important;overflow:hidden!important}body.dv-single-ppt-preview .dv-ppt-slide:not([data-slide="${slide}"]),body.dv-single-ppt-preview .slide[data-slide]:not([data-slide="${slide}"]){display:none!important}body.dv-single-ppt-preview .dv-ppt-slide[data-slide="${slide}"],body.dv-single-ppt-preview .slide[data-slide="${slide}"]{width:1120px!important;height:630px!important;max-width:none!important;max-height:none!important;aspect-ratio:16/9!important;margin:0!important;position:relative!important;overflow:hidden!important;box-shadow:none!important;contain:layout paint}body.dv-single-ppt-preview .dv-ppt-slide[data-slide="${slide}"] img,body.dv-single-ppt-preview .slide[data-slide="${slide}"] img{max-width:100%;max-height:100%}</style>`;
  const withStyle = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : `${style}${html}`;
  return /<body\b/i.test(withStyle) ? withBodyClass(withStyle, "dv-single-ppt-preview") : withStyle;
}

async function readPptPreviewHtml(slug: string, design: DesignMeta) {
  const fallback = renderPptPreview(design);
  const stored = await readText(previewPath(slug, "ppt")).catch(() => "");
  if (!stored) return fallback;
  const normalized = normalizeHtmlPreview(stored, `${design.title} PPT deck`);
  return isPptPreviewLayoutCompatible(normalized) ? normalized : fallback;
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  if (kind !== "web" && kind !== "ppt" && kind !== "card") return NextResponse.json({ error: "Unsupported preview kind." }, { status: 400 });

  const design = await getDesign(slug);
  if (!design) return NextResponse.json({ error: "Design not found." }, { status: 404 });

  const surface = url.searchParams.get("surface");
  const cardSurface = surface === "ppt" ? "ppt" : surface === "web" ? "web" : "library";
  const rawHtml =
    kind === "card"
      ? hasLocalizedCanvaPreview(design)
        ? renderCardPreview(design, cardSurface)
        : normalizeHtmlPreview(await readText(previewPath(slug, "card")).catch(() => renderCardPreview(design, cardSurface)), `${design.title} style card`)
      : kind === "ppt"
        ? focusPptSlide(
            await readPptPreviewHtml(slug, design),
            url.searchParams.get("slide"),
          )
        : renderWebPreview(design);

  // Always re-inject the token stylesheet — handles the historical-cache
  // case (pre-W1.4 previews on disk that have no `--dv-*` vars).
  const withTokens = injectTokensIntoHtml(rawHtml, design);
  const withCurrentAssets = rewriteDesignAssetUrls(withTokens, slug);
  // Then anchor bundle-relative asset URLs (`assets/foo.png`) to the file
  // route. Absolute `/api/designs/...` URLs were normalized above.
  const html = injectBundleBase(withCurrentAssets, slug);

  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
