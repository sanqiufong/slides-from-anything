import { compileTokenStylesheet } from "./token-stylesheet";
import { stripTitleBoilerplate } from "./title";
import type { ComponentMotionRecipe, DesignMeta } from "./types";

/**
 * Splice the W1.3 token stylesheet into a generated preview HTML so
 * downstream consumers (the detail-page iframe, the regenerate-docs
 * pipeline, archive snapshots) inherit `--dv-*` vars + `.dv-*`
 * utility classes even before this file's archetype templates have
 * been migrated off their hardcoded hex values. Inline templates can
 * still use literal colors; new code paths can read from `var(--dv-bg)`
 * etc. without breaking anything.
 */
function injectTokenStylesheet(html: string, meta: DesignMeta): string {
  const styleBlock = compileTokenStylesheet(meta.profile);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${styleBlock}\n</head>`);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${styleBlock}`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}\n${styleBlock}`);
  return `${styleBlock}\n${html}`;
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textValue(input: unknown, fallback = "") {
  if (typeof input === "string") {
    const value = input.trim();
    return value.length ? value : fallback;
  }
  if (typeof input === "number" && Number.isFinite(input)) return String(input);
  return fallback;
}

function textItems(items: unknown, fallback: string[] = []) {
  if (!Array.isArray(items)) return fallback;
  const normalized = items.map((item) => textValue(item)).filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

function inferPreviewStyle(meta: DesignMeta) {
  const aiRenderer = meta.profile?.previewStrategy?.renderer;
  // Only honor explicit renderer choices from the generated profile. Keyword
  // guessing here made unrelated imports inherit hardcoded visual genres.
  if (aiRenderer === "consumer-wallet") return "consumer-wallet";
  if (aiRenderer === "dark-event") return "dark-event";
  if (aiRenderer === "immersive-experiment") return "immersive-experiment";
  if (aiRenderer === "type-specimen") return "type-specimen";
  if (aiRenderer === "campaign") return "campaign";
  if (aiRenderer === "product-system" || aiRenderer === "editorial" || aiRenderer === "institutional" || aiRenderer === "custom") {
    return "product-system";
  }
  return "product-system";
}

function firstHeading(meta: DesignMeta) {
  const evidenceLine = textItems(meta.profile?.evidenceSummary).find((item) => item.includes("标题样本"));
  const headings = evidenceLine?.split("：")[1]?.split(" / ").map((item) => item.trim()).filter(Boolean);
  return headings?.[0] ?? meta.title;
}

function secondaryHeadings(meta: DesignMeta) {
  const evidenceLine = textItems(meta.profile?.evidenceSummary).find((item) => item.includes("标题样本"));
  const headings = evidenceLine?.split("：")[1]?.split(" / ").map((item) => item.trim()).filter(Boolean);
  return headings?.slice(1, 4) ?? ["Featured speakers", "Featured sessions", "FAQ"];
}

function semanticColors(meta: DesignMeta) {
  const { colors } = meta.tokens;
  const roles = meta.profile?.colorRoles;
  const surface = roles?.background ?? colors.surface;
  const primary = roles?.brandPrimary ?? colors.primary;
  const secondary = roles?.brandSecondary ?? colors.secondary;
  const text = readablePreviewTextColor(surface, [
    roles?.text,
    colors.text,
    colors.neutral,
    secondary,
    primary,
  ]);
  return {
    surface,
    text,
    primary,
    secondary,
  };
}

function parseHexColor(input: string | undefined) {
  const value = input?.trim();
  if (!value) return null;
  const short = value.match(/^#([0-9a-f]{3})$/i);
  if (short) {
    return short[1].split("").map((part) => Number.parseInt(part + part, 16));
  }
  const long = value.match(/^#([0-9a-f]{6})$/i);
  if (!long) return null;
  return [
    Number.parseInt(long[1].slice(0, 2), 16),
    Number.parseInt(long[1].slice(2, 4), 16),
    Number.parseInt(long[1].slice(4, 6), 16),
  ];
}

function relativeLuminance(input: string | undefined) {
  const rgb = parseHexColor(input);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string | undefined, b: string | undefined) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  if (l1 === null || l2 === null) return 0;
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

function readablePreviewTextColor(surface: string, candidates: Array<string | undefined>) {
  const filtered = candidates.filter((item): item is string => Boolean(item?.trim()));
  const initial = filtered[0] ?? "#111111";
  const best = filtered.reduce((current, candidate) => (
    contrastRatio(surface, candidate) > contrastRatio(surface, current) ? candidate : current
  ), initial);
  return contrastRatio(surface, initial) >= 3 ? initial : best;
}

function takeList(items: unknown, fallback: string[], limit: number) {
  const normalized = textItems(items);
  return (normalized.length > 0 ? normalized : fallback).slice(0, limit);
}

function cssTimeValue(value: string | undefined, fallback = "220ms") {
  const match = value?.match(/\b\d+(?:\.\d+)?m?s\b/i);
  return match?.[0] ?? fallback;
}

function cssScaledTime(value: string, multiplier: number) {
  const match = value.match(/^(\d+(?:\.\d+)?)(m?s)$/i);
  if (!match) return value;
  const amount = Number(match[1]);
  const unit = match[2];
  return `${Math.round(amount * multiplier)}${unit}`;
}

function cssEasingValue(value: string | undefined, fallback = "cubic-bezier(.2,.7,.2,1)") {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const cubic = normalized.match(/cubic-bezier\([^)]+\)/i)?.[0];
  if (cubic) return cubic;
  if (/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/i.test(normalized)) return normalized;
  return fallback;
}

function primaryMotionRecipe(meta: DesignMeta): ComponentMotionRecipe | undefined {
  return meta.profile?.componentMotionRecipes?.find((recipe) => recipe.confidence !== "low") ?? meta.profile?.componentMotionRecipes?.[0];
}

function motionRecipeDisplay(recipe: ComponentMotionRecipe | undefined, fallback = "source motion") {
  if (!recipe) return fallback;
  return compactLine(`${recipe.component} / ${recipe.trigger}`, fallback, 54);
}

function firstPreviewAsset(meta: DesignMeta) {
  const assets = meta.assets.filter((item) => item.kind === "image" || item.kind === "svg");
  if (meta.sourceMode === "canva-template" || meta.sourceMode === "canva-editor") {
    return assets.find((item) => /\/1600w-|1600w/i.test(item.sourceUrl ?? "")) ?? assets[0];
  }
  return assets[0];
}

function firstPreviewImage(meta: DesignMeta) {
  const asset = firstPreviewAsset(meta);
  if (!asset) return "";
  // Bundle-root-relative path. Combined with a `<base href=".../file/">`
  // injected at serve time, this resolves identically whether the bundle
  // is iframed locally, on the community server, or installed on a peer.
  return asset.path;
}

function isCanvaDesign(meta: DesignMeta) {
  return meta.sourceMode === "canva-template" || meta.sourceMode === "canva-editor";
}

/**
 * Generic visual-evidence score for an asset. Higher = more likely to be a
 * real, recognisable source visual (rendered viewport, hero/cover, og-image)
 * rather than an icon/favicon/sprite. Shared by the card/web/ppt previews to
 * decide whether to lead with a real screenshot, and re-exported for
 * card-preview.ts to order the asset list it hands the model.
 */
export function assetEvidenceScore(asset: DesignMeta["assets"][number]) {
  const corpus = `${asset.kind} ${asset.name} ${asset.path} ${asset.sourceUrl ?? ""}`.toLowerCase();
  let score = 0;
  if (asset.kind === "image") score += 40;
  if (asset.kind === "logo") score += 20;
  if (asset.kind === "svg") score += 8;
  if (/hero|cover|main|lead|masthead|banner|poster|og-image|twitter-image|source-image/.test(corpus)) score += 80;
  if (/visual-journey|rendered viewport|screenshot|scroll-y/.test(corpus)) score += 95;
  if (/background|bg|inline-bg|css-image/.test(corpus)) score += 45;
  if (/product|case|work|gallery|project|photo|image/.test(corpus)) score += 25;
  if (/\.(?:webp|avif|jpe?g|png)(?:[?#]|$)/.test(corpus) || /\/_next\/image\?/.test(corpus)) score += 18;
  if (/logo|brand|mark/.test(corpus)) score += asset.kind === "logo" ? 22 : -18;
  if (/favicon|sprite|icon-|apple-touch|mask-icon|placeholder|loader|pixel|tracking/.test(corpus)) score -= 90;
  return score;
}

// A page screenshot (visual-journey) scores 100; real hero/og imagery 70;
// content photo 45. "Strong" == 70+, so the hero is always a faithful depiction
// of the source — never a content thumbnail, and (see below) never a logo.
const STRONG_SCREENSHOT_SCORE = 70;

/**
 * Pick the asset that most faithfully depicts the rendered source, to LEAD a
 * preview with. This is a hero selector, not a generic ranker:
 *   - only raster `image` assets qualify — a logo/icon/svg blown up to fill an
 *     800x500 stage looks broken;
 *   - score off the asset NAME/PATH only (never `sourceUrl` — a logo served
 *     from a `/hero/` or `/_next/image?...` URL must not masquerade as a hero);
 *   - rank: real page screenshot (visual-journey) > og/hero imagery > content
 *     photo. Returns null when nothing depicts the source, so callers fall back
 *     to the specimen/LLM path instead of leading with a brand mark.
 * (assetEvidenceScore stays the ranker for the model's asset list, where logos
 *  and sourceUrl hints are legitimate context.)
 */
export function bestScreenshotAsset(meta: DesignMeta): { path: string; score: number } | null {
  // Honor a synthesis-pinned hero override (set only when the top/load viewport
  // is a desaturated intro frame and a later content viewport carries the brand
  // color — e.g. Yuga's black dot-matrix splash → its lime collection frame).
  const pinned = meta.profile?.previewStrategy?.heroAsset;
  if (pinned && meta.assets.some((asset) => asset.path === pinned)) {
    return { path: pinned, score: 100 };
  }
  let best: { path: string; score: number } | null = null;
  for (const asset of meta.assets) {
    if (asset.kind !== "image" || !asset.path) continue;
    const corpus = `${asset.name} ${asset.path}`.toLowerCase();
    if (/fallback|generated|placeholder|sprite|favicon|icon-|mask-icon|apple-touch|logo|wordmark|style-source/.test(corpus)) continue;
    let score: number;
    if (/visual-journey|rendered viewport|screenshot|scroll-viewport|load-viewport|scroll-y/.test(corpus)) score = 100;
    else if (/og-image|twitter-image|hero|cover|masthead|banner|poster|lead/.test(corpus)) score = 70;
    else if (/dom-image|product|gallery|project|photo|case|work|background/.test(corpus)) score = 45;
    else continue;
    if (!best || score > best.score) best = { path: asset.path, score };
  }
  return best;
}

/**
 * Gate for the screenshot-led preview path. Canva sources have no
 * visual-journey assets and keep their existing deterministic renderers, so
 * short-circuit to false for them.
 */
export function hasStrongScreenshot(meta: DesignMeta): boolean {
  if (isCanvaDesign(meta)) return false;
  const best = bestScreenshotAsset(meta);
  return best !== null && best.score >= STRONG_SCREENSHOT_SCORE;
}

function sourcePreviewImages(meta: DesignMeta, limit = 4) {
  const preferred = firstPreviewAsset(meta);
  return meta.assets
    .filter((asset) => (asset.kind === "image" || asset.kind === "svg") && !asset.path.includes("style-source.svg") && !/fallback|generated/i.test(asset.name))
    .sort((a, b) => {
      if (preferred && a.path === preferred.path) return -1;
      if (preferred && b.path === preferred.path) return 1;
      const aLarge = /\/1600w-|1600w/i.test(a.sourceUrl ?? "") ? 1 : 0;
      const bLarge = /\/1600w-|1600w/i.test(b.sourceUrl ?? "") ? 1 : 0;
      return bLarge - aLarge;
    })
    .slice(0, limit)
    .map((asset) => asset.path);
}

function sourceModeLabel(meta: DesignMeta, fallback: string) {
  if (meta.sourceMode === "canva-template") return "Canva 模板";
  if (meta.sourceMode === "canva-editor") return "Canva 编辑器";
  if (meta.sourceMode === "design-system-project") return "设计系统项目";
  if (meta.sourceMode === "clone-website") return "clone-website 接力";
  return fallback;
}

function compactLine(input: string | undefined, fallback: string, limit = 96) {
  const text = (input || fallback).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function packageLabel(meta: DesignMeta) {
  const packageType = meta.packageManifest?.packageType;
  if (packageType === "component-system") return "组件系统";
  if (packageType === "presentation-system") return "演示系统";
  if (packageType === "agent-skill-package") return "Skill 包";
  if (packageType === "visual-style-system") return "视觉系统";
  return sourceModeLabel(meta, "网站风格");
}

function cssFontFamily(input: string | undefined, fallback: string) {
  const value = (input || "").trim();
  if (!value || value.includes("var(")) return fallback;
  return value;
}

function sourceDisplayTitle(meta: DesignMeta) {
  const cleaned = stripTitleBoilerplate(meta.profile?.systemName || meta.title);
  return compactLine(cleaned || meta.title, meta.title, 44);
}

function sourceUsageLabel(meta: DesignMeta) {
  return meta.capabilities?.find((capability) => capability.category === "layout")?.label ?? meta.packageManifest?.packageType ?? sourceModeLabel(meta, "Template");
}

function sourceMetaLabel(meta: DesignMeta) {
  return meta.sourceHost || "design system";
}

function cardVariant(meta: DesignMeta) {
  const previewStyle = inferPreviewStyle(meta);
  if (previewStyle === "campaign") return "campaign";
  if (meta.packageManifest?.packageType === "component-system") return "component-system";
  if (meta.packageManifest?.packageType === "presentation-system" || meta.capabilities?.some((item) => item.id.includes("deck") || item.id.includes("slide"))) return "presentation-system";
  if (previewStyle === "consumer-wallet" || previewStyle === "dark-event" || previewStyle === "immersive-experiment" || previewStyle === "type-specimen") return previewStyle;
  return "editorial-system";
}

function slideTextSamples(meta: DesignMeta) {
  const presentation = meta.profile?.presentationStyle;
  const slideTypes = Array.isArray(presentation?.slideArchetypes) ? presentation.slideArchetypes : [];
  const components = Array.isArray(meta.profile?.componentSignatures) ? meta.profile.componentSignatures : [];
  const capabilities = meta.capabilities ?? [];
  const moduleItems = [
    ...slideTypes.map((item) => ({
      title: textValue(item.name, "Slide pattern"),
      body: textValue(item.use) || textItems(item.construction).join(" / "),
      label: "slide",
    })),
    ...capabilities.map((item) => ({
      title: item.label,
      body: item.usage || item.description,
      label: item.category,
    })),
    ...components.map((item) => ({
      title: textValue(item.name, "Component pattern"),
      body: textValue(item.role) || textItems(item.traits).join(" / "),
      label: "module",
    })),
  ];
  const fallback = [
    { title: "Title system", body: meta.profile?.openSlideGuidance.coverApproach ?? meta.summary, label: "title" },
    { title: "Data system", body: "Use source-derived evidence counts and role maps as data layouts.", label: "data" },
    { title: "Image system", body: "Use localized source visuals as the fidelity anchor.", label: "image" },
    { title: "Text system", body: meta.profile?.openSlideGuidance.direction ?? meta.summary, label: "text" },
  ];
  return (moduleItems.length ? moduleItems : fallback).slice(0, 6);
}

function imageFrames(meta: DesignMeta, limit = 4) {
  const images = sourcePreviewImages(meta, limit);
  const first = firstPreviewImage(meta);
  return images.length ? images : first ? [first] : [];
}

const PPT_SAMPLE_SLIDES = new Set(["title", "data", "image", "single", "multi"]);

type PptPreviewOptions = {
  slide?: string | null;
};

function normalizePptSampleSlide(slide: string | null | undefined) {
  if (!slide) return null;
  return PPT_SAMPLE_SLIDES.has(slide) ? slide : null;
}

function renderPptSampleDeck(meta: DesignMeta, selectedSlide?: string | null) {
  const { typography } = meta.tokens;
  const colors = semanticColors(meta);
  const activeSlide = normalizePptSampleSlide(selectedSlide);
  const slideAttrs = (slide: string) => `data-slide="${slide}"${activeSlide === slide ? ' data-selected="true"' : ""}`;
  const presentation = meta.profile?.presentationStyle;
  const displayFont = cssFontFamily(meta.profile?.typographyRoles?.display || typography.families.display, "Arial Black, Arial, sans-serif");
  const bodyFont = cssFontFamily(meta.profile?.typographyRoles?.body || typography.families.primary, "Inter, ui-sans-serif, system-ui, sans-serif");
  const monoFont = cssFontFamily(meta.profile?.typographyRoles?.mono || typography.families.mono, "IBM Plex Mono, ui-monospace, monospace");
  const title = sourceDisplayTitle(meta);
  const sourceLabel = sourceMetaLabel(meta);
  const usageLabel = sourceUsageLabel(meta);
  const images = imageFrames(meta, 5);
  const heroImage = bestScreenshotAsset(meta)?.path || images[0];
  const modules = slideTextSamples(meta);
  const singleModule = modules[0];
  const motionRecipe = primaryMotionRecipe(meta);
  const motionDuration = cssTimeValue(motionRecipe?.timing.duration, cssTimeValue(meta.tokens.motion.transition, "220ms"));
  const motionEasing = cssEasingValue(motionRecipe?.timing.easing ?? meta.tokens.motion.easing);
  const motionStagger = cssTimeValue(motionRecipe?.timing.stagger, "90ms");
  const motionLong = cssScaledTime(motionDuration, 1.4);
  const motionLine = cssScaledTime(motionDuration, 1.8);
  const motionBar = cssScaledTime(motionDuration, 1.5);
  const motionLabel = motionRecipeDisplay(motionRecipe, "source reveal");
  const qualityChecks = takeList(presentation?.qualityChecks, meta.profile?.methodology?.fidelityChecks ?? ["Preview must remain source-recognisable."], 3);
  const data = [
    { value: String(meta.assets.length), label: "assets", note: "localized" },
    { value: String(meta.capabilities?.length ?? meta.profile?.componentSignatures.length ?? 0), label: "capabilities", note: "routed" },
    { value: String(Object.values(meta.tokens.colors).filter(Boolean).length), label: "colors", note: "roles" },
    { value: String(meta.profile?.antiPatterns.length ?? 0), label: "gates", note: "review" },
  ];
  const bars = data.map((item, index) => {
    const width = Math.max(22, Math.min(92, Number(item.value) * 9 + 24 + index * 6));
    return `<span style="--w:${width}%"><b>${escapeHtml(item.label)}</b><i></i><em>${escapeHtml(item.value)}</em></span>`;
  }).join("");
  const imageMarkup = heroImage
    ? `<img src="${heroImage}" alt="${escapeHtml(meta.title)} source visual" />`
    : `<div class="source-placeholder"><i></i><i></i><i></i></div>`;
  const thumbnails = (images.length ? images : ["", "", ""]).slice(0, 3).map((image, index) => (
    image
      ? `<div class="thumb"><img src="${image}" alt="" /></div>`
      : `<div class="thumb empty"><span>${String(index + 1).padStart(2, "0")}</span></div>`
  )).join("");
  const multiModules = modules.slice(0, 4).map((item, index) => `
    <article class="module-card">
      <span>${String(index + 1).padStart(2, "0")} / ${escapeHtml(item.label)}</span>
      <b>${escapeHtml(compactLine(item.title, "Module", 38))}</b>
      <p>${escapeHtml(compactLine(item.body, meta.summary, 86))}</p>
    </article>
  `).join("");
  const flowIcons = ["IN", "AI", "QA", "OUT"];
  const flowNodes = modules.slice(0, 4).map((item, index) => `
    <article class="flow-node">
      <div class="flow-icon">${flowIcons[index] ?? String(index + 1).padStart(2, "0")}</div>
      <div class="flow-copy">
        <span>${String(index + 1).padStart(2, "0")} / ${escapeHtml(item.label)}</span>
        <b>${escapeHtml(compactLine(item.title, "Module", 34))}</b>
      </div>
      <em>${escapeHtml(compactLine(item.body, "source-derived", 34))}</em>
    </article>
  `).join("");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · PPT Layout Samples</title>
    <style>
      :root{--surface:${colors.surface};--text:${colors.text};--primary:${colors.primary};--secondary:${colors.secondary};--neutral:${meta.tokens.colors.neutral};--display:${displayFont};--body:${bodyFont};--mono:${monoFont};--line:color-mix(in srgb,var(--text) 16%,transparent);--muted:color-mix(in srgb,var(--text) 62%,transparent);--motion-duration:${motionDuration};--motion-long:${motionLong};--motion-line:${motionLine};--motion-bar:${motionBar};--motion-ease:${motionEasing};--motion-stagger:${motionStagger}}
      *{box-sizing:border-box}
      body{margin:0;background:#e9eef5;color:var(--text);font-family:var(--body),system-ui,sans-serif}
      main{min-height:100vh;padding:clamp(14px,3vw,34px);display:grid;gap:22px;align-content:start}
      .slide{position:relative;width:min(1120px,100%);aspect-ratio:16/9;margin:0 auto;overflow:hidden;contain:layout paint;border:1px solid var(--line);background:var(--surface);box-shadow:0 22px 58px rgba(15,23,42,.13)}
      .slide > *{min-width:0;min-height:0}
      @keyframes dv-motion-settle{from{opacity:0;transform:translate3d(0,22px,0) scale(.985);filter:blur(3px)}to{opacity:1;transform:translate3d(0,0,0) scale(1);filter:blur(0)}}
      @keyframes dv-motion-mask{from{clip-path:inset(0 28% 0 0);transform:scale(1.035);opacity:.78}to{clip-path:inset(0 0 0 0);transform:scale(1);opacity:1}}
      @keyframes dv-motion-line{from{transform:scaleX(0);opacity:.35}to{transform:scaleX(1);opacity:1}}
      @keyframes dv-motion-bar{from{width:0;opacity:.4}to{width:var(--w);opacity:1}}
      .slide-label,.meta-chip,h1,h2,h3,p,.metric,.single-card,.module-card,.thumb{animation:dv-motion-settle var(--motion-duration) var(--motion-ease) both}
      .title-copy h1{animation-delay:var(--motion-stagger)}.title-copy p{animation-delay:var(--motion-stagger)}.title-art,.image-main{animation:dv-motion-mask var(--motion-long) var(--motion-ease) both}.chart i{animation:dv-motion-bar var(--motion-bar) var(--motion-ease) both}.module-card:nth-child(2),.thumb:nth-child(3){animation-delay:var(--motion-stagger)}.module-card:nth-child(3),.thumb:nth-child(4){animation-delay:var(--motion-stagger)}.module-card:nth-child(4){animation-delay:var(--motion-stagger)}
      .motion-rail{position:absolute;z-index:5;left:5.4%;right:5.4%;bottom:5.2%;height:3px;background:linear-gradient(90deg,var(--primary),transparent);transform-origin:left;animation:dv-motion-line var(--motion-line) var(--motion-ease) both}.motion-note{position:absolute;z-index:5;right:5.4%;bottom:6.2%;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:clamp(8px,.85vw,11px);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);animation:dv-motion-settle var(--motion-duration) var(--motion-ease) both}
      body.single-preview{background:transparent}
      body.single-preview main{display:block;min-height:0;padding:0}
      body.single-preview .slide{display:none;width:1120px;max-width:none;margin:0;border:0;box-shadow:none}
      body.single-preview .slide[data-selected="true"]{display:grid}
      .slide-label{position:absolute;z-index:4;left:5.4%;top:5.2%;font-family:var(--mono),ui-monospace,monospace;font-size:clamp(9px,1vw,12px);font-weight:850;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
      h1,h2,h3,p{margin:0;max-width:100%;overflow-wrap:anywhere}
      h1,h2,h3{font-family:var(--display),var(--body),system-ui,sans-serif;letter-spacing:0;text-wrap:balance}
      h1{font-size:clamp(42px,7.4vw,86px);line-height:.95;font-weight:900}
      h2{font-size:clamp(30px,5vw,62px);line-height:.98;font-weight:900}
      h3{font-size:clamp(20px,2.7vw,34px);line-height:1.05;font-weight:850}
      p{font-size:clamp(13px,1.45vw,18px);line-height:1.48;color:var(--muted)}
      .title-copy h1,.title-copy p,.image-side h3,.single-card h2,.single-card p,.module-card b,.module-card p,.checks span{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
      .title-copy h1{-webkit-line-clamp:3}.title-copy p{-webkit-line-clamp:3}.image-side h3{-webkit-line-clamp:3}.single-card h2{-webkit-line-clamp:3}.single-card p{-webkit-line-clamp:5}.module-card b{-webkit-line-clamp:2}.module-card p{-webkit-line-clamp:4}.checks span{-webkit-line-clamp:3}
      .meta-chip{display:inline-flex;width:max-content;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--line);background:color-mix(in srgb,var(--primary) 10%,var(--surface));padding:8px 11px;font-family:var(--mono);font-size:clamp(9px,1vw,12px);font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--text)}
      .title-slide{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(260px,.95fr);gap:0}
      .title-copy{display:grid;align-content:end;gap:18px;padding:10% 8% 8% 8%;min-width:0}
      .title-copy p{max-width:720px}.title-art{position:relative;min-width:0;background:var(--secondary);overflow:hidden}
      .title-art img,.image-main img,.thumb img{width:100%;height:100%;object-fit:cover;display:block}
      .title-art:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.04),rgba(0,0,0,.28))}
      .source-placeholder{position:absolute;inset:0;background:linear-gradient(135deg,var(--secondary),color-mix(in srgb,var(--primary) 54%,var(--surface)));overflow:hidden}
      .source-placeholder i{position:absolute;background:color-mix(in srgb,var(--text) 84%,transparent)}.source-placeholder i:nth-child(1){left:12%;top:16%;width:46%;height:56%}.source-placeholder i:nth-child(2){right:12%;top:14%;width:22%;height:22%;border-radius:999px}.source-placeholder i:nth-child(3){right:16%;bottom:18%;width:34%;height:8%}
      .data-slide{padding:8% 7%;display:grid;grid-template-columns:.82fr 1.18fr;gap:36px;align-items:end}
      .metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      .metric{border-top:1px solid var(--line);padding-top:14px;min-width:0}.metric b{display:block;font-family:var(--display);font-size:clamp(42px,6vw,76px);line-height:.9}.metric span{font-family:var(--mono);font-size:clamp(9px,1vw,12px);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
      .chart{display:grid;gap:12px;align-content:end}.chart span{display:grid;grid-template-columns:120px minmax(0,1fr) 42px;gap:12px;align-items:center;font-family:var(--mono);font-size:clamp(9px,1vw,12px);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.chart i{display:block;height:18px;background:linear-gradient(90deg,var(--primary),var(--secondary));width:var(--w)}.chart em{font-style:normal;color:var(--text);font-weight:850}
      .image-slide{padding:6.6%;display:grid;grid-template-columns:1.25fr .75fr;gap:18px}
      .image-main{position:relative;overflow:hidden;background:var(--secondary);border:1px solid var(--line);min-height:0}.image-main:after{content:"";position:absolute;left:18px;right:18px;bottom:18px;height:1px;background:rgba(255,255,255,.5)}
      .image-side{display:grid;grid-template-rows:auto repeat(3,minmax(0,1fr));gap:14px}.thumb{position:relative;overflow:hidden;border:1px solid var(--line);background:color-mix(in srgb,var(--secondary) 32%,var(--surface))}.thumb.empty{display:grid;place-items:center;font-family:var(--mono);font-weight:900;color:var(--muted)}
      .single-slide{padding:7.2%;display:grid;grid-template-columns:90px minmax(0,1fr);gap:34px;align-items:center}
      .rail{height:100%;border-right:1px solid var(--line);display:flex;flex-direction:column;justify-content:space-between;font-family:var(--mono);font-size:clamp(9px,1vw,12px);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);writing-mode:vertical-rl;padding-right:20px}
      .single-card{display:grid;gap:22px;max-width:820px}.single-card p{font-size:clamp(17px,2vw,25px);line-height:1.45}.checks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.checks span{border-top:1px solid var(--line);padding-top:10px;font-family:var(--mono);font-size:clamp(9px,1vw,12px);line-height:1.35;color:var(--muted)}
      .multi-slide{padding:7%;display:grid;grid-template-rows:auto minmax(0,1fr);gap:24px}
      .multi-head{display:flex;align-items:end;justify-content:space-between;gap:20px}.multi-head h2{max-width:680px}.module-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;min-height:0}
      .module-card{display:grid;align-content:space-between;gap:14px;min-width:0;border:1px solid var(--line);background:color-mix(in srgb,var(--surface) 88%,white);padding:18px}.module-card span{font-family:var(--mono);font-size:clamp(9px,1vw,12px);letter-spacing:.14em;text-transform:uppercase;color:var(--primary);font-weight:850}.module-card b{font-family:var(--display);font-size:clamp(18px,2vw,27px);line-height:1.05}.module-card p{font-size:clamp(12px,1.25vw,15px)}
      .flow-board{display:grid;grid-template-rows:minmax(0,1fr) auto;gap:16px;min-height:0;border:1px solid var(--line);background:color-mix(in srgb,var(--surface) 90%,var(--primary));padding:22px;overflow:hidden}
      .flow-track{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;align-items:stretch;min-height:0}
      .flow-node{position:relative;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:14px;min-width:0;min-height:0;border:1px solid var(--line);background:color-mix(in srgb,var(--surface) 92%,white);padding:18px;overflow:hidden;animation:dv-motion-settle var(--motion-duration) var(--motion-ease) both}
      .flow-node:not(:last-child)::after{content:"";position:absolute;right:-18px;top:50%;width:18px;height:2px;background:var(--primary);transform:translateY(-50%);transform-origin:left;animation:dv-motion-line var(--motion-line) var(--motion-ease) both}
      .flow-icon{width:44px;height:44px;border-radius:999px;display:grid;place-items:center;background:var(--primary);color:var(--surface);font-family:var(--mono);font-size:12px;font-weight:900;letter-spacing:.08em;box-shadow:0 0 0 6px color-mix(in srgb,var(--primary) 16%,transparent)}
      .flow-copy{display:grid;gap:8px;min-width:0}.flow-copy span{font-family:var(--mono);font-size:clamp(8px,.9vw,11px);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:850}.flow-copy b{font-family:var(--display);font-size:clamp(18px,2.2vw,30px);line-height:1.02;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .flow-node em{font-style:normal;font-family:var(--mono);font-size:clamp(9px,1vw,12px);line-height:1.35;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .flow-status{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.flow-status span{display:flex;align-items:center;gap:8px;min-width:0;border-top:1px solid var(--line);padding-top:10px;font-family:var(--mono);font-size:clamp(9px,1vw,12px);font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.flow-status span::before{content:"";width:10px;height:10px;border-radius:999px;background:var(--primary);flex:none}
      @media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important;scroll-behavior:auto!important}.title-art,.image-main{clip-path:none!important;transform:none!important;filter:none!important}}
      @media(max-width:760px){.title-slide,.data-slide,.image-slide,.single-slide{grid-template-columns:1fr}.title-art{min-height:260px}.data-slide,.image-slide,.single-slide,.multi-slide{padding:28px}.module-grid,.metrics,.checks,.flow-track,.flow-status{grid-template-columns:1fr}.flow-node:not(:last-child)::after{display:none}.rail{display:none}.image-side{grid-template-rows:auto repeat(2,minmax(120px,1fr))}.thumb:nth-child(n+4){display:none}}
    </style>
  </head>
  <body${activeSlide ? ' class="single-preview"' : ""}>
    <main>
      <section class="slide dv-ppt-slide title-slide" ${slideAttrs("title")}>
        <div class="slide-label">01 / title</div>
        <div class="title-copy">
          <span class="meta-chip">${escapeHtml(sourceLabel)} · ${escapeHtml(usageLabel)}</span>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(compactLine(meta.profile?.openSlideGuidance.coverApproach ?? meta.summary, meta.summary, 126))}</p>
        </div>
        <div class="title-art">${imageMarkup}</div>
        <div class="motion-rail" aria-hidden="true"></div>
        <div class="motion-note">${escapeHtml(motionLabel)}</div>
      </section>
      <section class="slide dv-ppt-slide data-slide" ${slideAttrs("data")}>
        <div class="slide-label">02 / data</div>
        <div>
          <span class="meta-chip">source evidence</span>
          <h2 style="margin-top:18px;">Data display</h2>
          <p style="margin-top:16px;">用抽象出的证据数量、能力和约束展示数据页排版，不虚构业务指标。</p>
        </div>
        <div class="metrics">
          ${data.map((item) => `<div class="metric"><b>${escapeHtml(item.value)}</b><span>${escapeHtml(item.label)} / ${escapeHtml(item.note)}</span></div>`).join("")}
        </div>
        <div class="chart" style="grid-column:1 / -1">${bars}</div>
      </section>
      <section class="slide dv-ppt-slide image-slide" ${slideAttrs("image")}>
        <div class="slide-label">03 / image</div>
        <div class="image-main">${imageMarkup}</div>
        <aside class="image-side">
          <div>
            <span class="meta-chip">image layout</span>
            <h3 style="margin-top:14px;">${escapeHtml(compactLine(meta.profile?.visualDna?.layoutGrammar, "Source image treatment", 86))}</h3>
          </div>
          ${thumbnails}
        </aside>
      </section>
      <section class="slide dv-ppt-slide single-slide" ${slideAttrs("single")}>
        <div class="slide-label">04 / text single</div>
        <div class="rail"><span>single module</span><span>${escapeHtml(sourceLabel)}</span></div>
        <div class="single-card">
          <span class="meta-chip">${escapeHtml(singleModule?.label ?? "text")}</span>
          <h2>${escapeHtml(compactLine(singleModule?.title, "Single text module", 72))}</h2>
          <p>${escapeHtml(compactLine(singleModule?.body, meta.profile?.visualThesis ?? meta.summary, 168))}</p>
          <div class="checks">${qualityChecks.map((item) => `<span>${escapeHtml(compactLine(item, item, 62))}</span>`).join("")}</div>
        </div>
      </section>
      <section class="slide dv-ppt-slide multi-slide" ${slideAttrs("multi")}>
        <div class="slide-label">05 / text multi</div>
        <div class="multi-head">
          <h2>Workflow module system</h2>
          <span class="meta-chip">${escapeHtml(packageLabel(meta))}</span>
        </div>
        <div class="flow-board">
          <div class="flow-track">${flowNodes || multiModules}</div>
          <div class="flow-status">
            <span>scan first</span>
            <span>short labels</span>
            <span>source rhythm</span>
          </div>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderScreenshotLedCardPreview(meta: DesignMeta, surface: "web" | "ppt" | "library") {
  const images = sourcePreviewImages(meta, 3);
  const image = bestScreenshotAsset(meta)?.path || images[0] || firstPreviewImage(meta);
  const colors = semanticColors(meta);
  const displayFont = cssFontFamily(meta.profile?.typographyRoles?.display || meta.tokens.typography.families.display, "Arial Black, Arial, sans-serif");
  const monoFont = cssFontFamily(meta.profile?.typographyRoles?.mono || meta.tokens.typography.families.mono, "IBM Plex Mono, ui-monospace, monospace");
  const title = sourceDisplayTitle(meta);
  const label = sourceUsageLabel(meta);
  const sourceLabel = sourceMetaLabel(meta);
  const modeLabel = surface === "ppt" ? "PPT derivative" : surface === "web" ? "Web derivative" : sourceModeLabel(meta, "Source");
  // Full-page website screenshots already carry their own title, nav and
  // branding, so the dark gradient + redundant white headline (designed for
  // single-image Canva derivatives) clashes — worst on light brands like Le
  // Puzz. Render those clean (screenshot edge-to-edge, top-anchored, just a
  // small source chip); keep the caption treatment only for Canva.
  const clean = !isCanvaDesign(meta);
  const imageMarkup = image
    ? `<img src="${image}" alt="${escapeHtml(meta.title)} source visual" />`
    : `<div class="synthetic"><i></i><i></i><i></i></div>`;
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · Style Derivative</title>
    <style>
      :root{--surface:${colors.surface};--text:${colors.text};--primary:${colors.primary};--secondary:${colors.secondary};--neutral:${meta.tokens.colors.neutral};--display:${displayFont};--mono:${monoFont};}
      *{box-sizing:border-box}
      html,body{width:100%;height:100%;overflow:hidden}
      body{margin:0;background:var(--surface);font-family:Arial,Helvetica,sans-serif;color:var(--text)}
      .style-card{position:relative;width:800px;height:500px;overflow:hidden;background:var(--surface);padding:22px;isolation:isolate}
      .stage{position:relative;width:100%;height:100%;overflow:hidden;border:1px solid color-mix(in srgb,var(--text) 18%,transparent);background:var(--secondary);box-shadow:0 18px 42px rgba(15,23,42,.16)}
      .stage img{display:block;width:100%;height:100%;object-fit:cover;object-position:center;filter:saturate(1.04) contrast(1.02)}
      .style-card.clean .stage img{object-position:top}
      .style-card:not(.clean) .stage:after{content:"";position:absolute;inset:auto 0 0;height:42%;background:linear-gradient(180deg,transparent,rgba(0,0,0,.42));opacity:.5;pointer-events:none}
      .src-chip{position:absolute;z-index:2;left:14px;top:14px;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid color-mix(in srgb,var(--text) 16%,transparent);border-radius:7px;background:color-mix(in srgb,var(--surface) 86%,transparent);backdrop-filter:blur(10px);padding:6px 9px;font-family:var(--mono),monospace;font-size:11px;font-weight:800;letter-spacing:.04em;color:var(--text);text-transform:lowercase}
      .synthetic{position:absolute;inset:0;background:var(--secondary)}.synthetic i{position:absolute;background:var(--primary);opacity:.88}.synthetic i:nth-child(1){left:8%;top:12%;width:42%;height:64%;border-radius:22px}.synthetic i:nth-child(2){right:9%;top:16%;width:22%;height:22%;border-radius:999px;background:var(--text)}.synthetic i:nth-child(3){right:12%;bottom:18%;width:34%;height:8%;border-radius:999px}
      .top{position:absolute;z-index:2;left:22px;right:22px;top:22px;display:flex;justify-content:space-between;gap:20px;align-items:center;color:#fff;text-shadow:0 1px 18px rgba(0,0,0,.38);font-family:var(--mono),monospace;font-size:12px;font-weight:850}
      .top span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:lowercase}
      .top span:last-child{letter-spacing:.16em;opacity:.9}
      .caption{position:absolute;z-index:2;left:22px;right:22px;bottom:22px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:end}
      h1{margin:0;max-width:520px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:#fff;font-family:var(--display),Arial Black,Arial,sans-serif;font-size:44px;line-height:.95;font-weight:900;letter-spacing:-.045em;text-shadow:0 2px 24px rgba(0,0,0,.42)}
      .tag{align-self:end;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid rgba(255,255,255,.42);background:color-mix(in srgb,var(--surface) 82%,transparent);color:var(--text);padding:10px 13px;font-size:12px;font-weight:780;backdrop-filter:blur(14px)}
      .mode{position:absolute;left:22px;bottom:8px;color:rgba(255,255,255,.72);font-family:var(--mono),monospace;font-size:8px;font-weight:850;letter-spacing:.16em;text-transform:uppercase;text-shadow:0 1px 12px rgba(0,0,0,.42)}
    </style>
  </head>
  <body>
    <main class="style-card ${surface}${clean ? " clean" : ""}">
      <section class="stage">
        ${imageMarkup}
        ${clean
          ? `<div class="src-chip">${escapeHtml(sourceLabel)}</div>`
          : `<div class="top"><span>${escapeHtml(sourceLabel)}</span><span>01</span></div>`}
      </section>
      ${clean ? "" : `<section class="caption">
        <h1>${escapeHtml(title)}</h1>
        <div class="tag">${escapeHtml(label)}</div>
      </section>
      <div class="mode">${escapeHtml(modeLabel)}</div>`}
    </main>
  </body>
</html>`;
}

function cardSpecimenMarkup(meta: DesignMeta, variant: string, surface: "web" | "ppt" | "library") {
  const image = firstPreviewImage(meta);
  const headline = compactLine(firstHeading(meta), meta.title, 62);
  const capability = meta.capabilities?.[0]?.id ?? meta.profile?.previewStrategy?.renderer ?? packageLabel(meta);
  const label = surface === "ppt" ? "Slide" : surface === "web" ? "Web" : "Specimen";
  const shortName = compactLine((meta.profile?.systemName || meta.title).replace(/\s+—\s+.*/, ""), meta.title, 28);

  if (variant === "source-image") {
    return `
      <div class="source-card">
        <div class="source-image" style="background-image:url('${image}')">
          <span>${escapeHtml(sourceModeLabel(meta, label))}</span>
        </div>
        <div class="source-caption">
          <b>${escapeHtml(headline)}</b>
          <small>${escapeHtml(meta.sourceHost)}</small>
        </div>
      </div>`;
  }

  if (variant === "component-system") {
    return `
      <div class="chrome"><b>${escapeHtml(meta.title)}</b><span>${escapeHtml(capability)}</span></div>
      <div class="dashboard">
        <aside><span></span><span></span><span></span><span></span></aside>
        <main>
          <div class="metrics"><i></i><i></i><i></i></div>
          <div class="chart"><span></span><span></span><span></span><span></span></div>
          <div class="table">${[0, 1, 2, 3].map(() => "<p><b></b><em></em><strong></strong></p>").join("")}</div>
        </main>
      </div>`;
  }

  if (variant === "presentation-system") {
    return `
      <div class="magazine">
        <div class="mag-copy">
          <small>${escapeHtml(label)}</small>
          <h1>${escapeHtml(headline)}</h1>
          <div class="mag-rule"></div>
        </div>
        <div class="mag-art" ${image ? `style="background-image:linear-gradient(180deg,rgba(0,0,0,.12),rgba(0,0,0,.46)),url('${image}')"` : ""}>
          <span>${escapeHtml(capability)}</span>
        </div>
      </div>`;
  }

  if (variant === "campaign") {
    return `
      <div class="campaign">
        <div class="campaign-image" ${image ? `style="background-image:url('${image}')"` : ""}></div>
        <div class="campaign-type">
          <small>${escapeHtml(sourceMetaLabel(meta))}</small>
          <h1>${escapeHtml(sourceDisplayTitle(meta))}</h1>
          <span>${escapeHtml(sourceUsageLabel(meta))}</span>
        </div>
      </div>`;
  }

  if (variant === "consumer-wallet") {
    return `
      <div class="wallet-nav"><b>${escapeHtml(meta.profile?.systemName || meta.title)}</b><span>Download</span></div>
      <div class="wallet-stage">
        <i></i>
        <div><small>${escapeHtml(label)}</small><h1>${escapeHtml(headline)}</h1></div>
      </div>`;
  }

  if (variant === "type-specimen") {
    return `
      <div class="type-grid">
        <div class="type-top"><b>${escapeHtml(meta.sourceHost)}</b><span>Type Tester</span></div>
        <h1>${escapeHtml(headline.split(" ").slice(0, 3).join(" "))}</h1>
        <div class="axes"><span>Mono</span><span>Semi</span><span>Poly</span></div>
      </div>`;
  }

  if (variant === "immersive-experiment") {
    return `
      <div class="lab">
        <div class="hud"><span>LAB</span><span>${escapeHtml(meta.sourceHost)}</span></div>
        <div class="gate">CLICK TO ENTER</div>
        <h1>${escapeHtml(headline)}</h1>
        <div class="hud bottom"><span>00:00:00</span><span>${escapeHtml(capability)}</span></div>
      </div>`;
  }

  if (variant === "dark-event") {
    return `
      <div class="event">
        <div class="event-nav"><span>Speakers</span><b>${escapeHtml(meta.title)}</b><span>Ticket</span></div>
        <div class="nodes"><i></i><i></i><i></i><i></i><i></i></div>
        <h1>${escapeHtml(headline)}</h1>
        <button>Get ticket</button>
      </div>`;
  }

  return `
    <div class="editorial">
      <div class="editorial-rail"><span>01</span><span>${escapeHtml(label)}</span></div>
      <div class="editorial-copy">
        <small>${escapeHtml(meta.sourceHost)}</small>
        <h1>${escapeHtml(shortName)}</h1>
      </div>
      <div class="editorial-panel">
        <b>${escapeHtml(headline)}</b>
        <i></i><i></i><i></i>
      </div>
    </div>`;
}

/**
 * P6 swatches: when the design carries 4+ canonical-tagged accentPalette
 * entries (typically multi-theme skill packages like guizang's 9-theme
 * Magazine+Swiss bundle), render a theme strip showing each palette
 * entry's hex + truncated themeName label. Otherwise fall back to the
 * 4-fixed-swatch row (bg / text / primary / secondary) the card has
 * always shipped with.
 *
 * The strip uses inline styles so it's self-contained and doesn't
 * depend on additional CSS classes outside the existing .swatches rules.
 */
function renderCardSwatches(meta: DesignMeta): string {
  const palette = meta.profile?.colorRoles?.accentPalette;
  if (!palette || palette.length < 4) {
    return `<div class="swatches" aria-hidden="true"><i></i><i></i><i></i><i></i></div>`;
  }
  // Cap to 10 to keep the strip from overflowing the 800px card.
  const entries = palette.slice(0, 10);
  const chips = entries.map((entry) => {
    const hex = entry.hex;
    const rawLabel = entry.role || entry.canonicalRole || "";
    // Strip leading non-letter decoration (matches theme-markdown-parser logic),
    // collapse whitespace, truncate to ~14 chars for chip fit.
    const cleaned = rawLabel.replace(/^[^A-Za-z一-鿿]+/, "").trim();
    const label = cleaned.length > 14 ? cleaned.slice(0, 13) + "…" : cleaned;
    return `<span title="${escapeHtml(rawLabel)} ${escapeHtml(hex)}" style="display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:4px;padding:3px 5px;background:color-mix(in srgb,${hex} 14%, var(--stage));color:var(--text);font-size:9px;font-weight:700;line-height:1;white-space:nowrap;max-width:96px;overflow:hidden;text-overflow:ellipsis"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${hex};box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)"></i>${escapeHtml(label)}</span>`;
  }).join("");
  return `<div class="theme-strip" aria-label="Theme palette swatches" style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;max-width:60%">${chips}</div>`;
}

export function renderCardPreview(meta: DesignMeta, surface: "web" | "ppt" | "library" = "library") {
  if (isCanvaDesign(meta) || hasStrongScreenshot(meta)) return renderScreenshotLedCardPreview(meta, surface);

  const { typography } = meta.tokens;
  const displayFont = cssFontFamily(meta.profile?.typographyRoles?.display || typography.families.display, "Georgia, 'Times New Roman', serif");
  const bodyFont = cssFontFamily(meta.profile?.typographyRoles?.body || typography.families.primary, "Inter, ui-sans-serif, system-ui, sans-serif");
  const colors = semanticColors(meta);
  const variant = cardVariant(meta);
  const isDark = /#0|#1|black|dark|immersive|event/.test(`${colors.surface} ${meta.profile?.archetype} ${variant}`.toLowerCase());
  const background = colors.surface;
  const text = colors.text;
  const primary = colors.primary;
  const secondary = colors.secondary;
  const mutedText = isDark ? "rgba(255,255,255,.68)" : "rgba(15,23,42,.62)";
  const line = isDark ? "rgba(255,255,255,.18)" : "rgba(15,23,42,.13)";
  const stageTone = isDark ? "#050505" : "#ffffff";
  const motionRecipe = primaryMotionRecipe(meta);
  const motionDuration = cssTimeValue(motionRecipe?.timing.duration, cssTimeValue(meta.tokens.motion.transition, "220ms"));
  const motionEasing = cssEasingValue(motionRecipe?.timing.easing ?? meta.tokens.motion.easing);
  const chips = [
    packageLabel(meta),
    meta.capabilities?.[0]?.id,
    meta.profile?.previewStrategy?.renderer,
  ].filter(Boolean).slice(0, 3);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · Style Card</title>
    <style>
      :root{--bg:${background};--text:${text};--primary:${primary};--secondary:${secondary};--muted:${mutedText};--line:${line};--stage:${stageTone};--display:${displayFont};--body:${bodyFont};--motion-duration:${motionDuration};--motion-ease:${motionEasing};}
      *{box-sizing:border-box} html,body{width:100%;height:100%;overflow:hidden} body{margin:0;background:var(--bg);color:var(--text);font-family:var(--body),system-ui,sans-serif}
      @keyframes dv-card-settle{from{opacity:0;transform:translate3d(0,18px,0) scale(.985);filter:blur(3px)}to{opacity:1;transform:translate3d(0,0,0) scale(1);filter:blur(0)}}
      @keyframes dv-card-scan{from{transform:scaleX(0);opacity:.3}to{transform:scaleX(1);opacity:1}}
      .card{position:relative;display:grid;height:100%;min-height:0;overflow:hidden;padding:20px;background:linear-gradient(135deg,color-mix(in srgb,var(--bg) 94%, white),var(--bg));}
      .shell{position:relative;display:grid;height:100%;min-height:0;grid-template-rows:auto minmax(0,1fr) auto;gap:14px;overflow:hidden;border:1px solid var(--line);border-radius:22px;background:color-mix(in srgb,var(--stage) 88%, transparent);box-shadow:0 28px 70px rgba(15,23,42,.16);animation:dv-card-settle var(--motion-duration) var(--motion-ease) both}
      .shell:after{content:"";position:absolute;left:16px;right:16px;bottom:45px;height:1px;background:var(--line);opacity:.55;transform-origin:left;animation:dv-card-scan var(--motion-duration) var(--motion-ease) both}
      .meta{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 0}.brand{min-width:0;font-size:13px;font-weight:800}.brand span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.brand small{display:block;margin-top:3px;color:var(--muted);font-size:10px;font-weight:700;text-transform:uppercase}.chips{display:flex;gap:6px;min-width:0}.chips span{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:5px 8px;background:transparent;color:var(--muted);font-size:9px;font-weight:650}
      .specimen{min-height:0;padding:0 16px 0}.caption{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:end;border-top:1px solid var(--line);padding:12px 16px 14px;color:var(--muted);font-size:11px;line-height:1.35}.caption b{display:block;color:var(--text);font-size:12px}.caption span{display:block;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.swatches{display:flex;gap:4px;opacity:.85}.swatches i{width:20px;height:12px;border:1px solid var(--line);border-radius:4px}.swatches i:nth-child(1){background:var(--bg)}.swatches i:nth-child(2){background:var(--text)}.swatches i:nth-child(3){background:var(--primary)}.swatches i:nth-child(4){background:var(--secondary)}
      h1{margin:0;font-family:var(--display),var(--body),system-ui,sans-serif;font-size:36px;line-height:.98;max-width:820px;text-wrap:balance} p{margin:0;color:var(--muted);font-size:13px;line-height:1.45}
      .wallet-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.wallet-nav b{font-size:20px}.wallet-nav span{border-radius:999px;background:var(--primary);color:var(--bg);padding:9px 18px;font-size:12px;font-weight:800}.wallet-stage{position:relative;display:grid;height:100%;min-height:0;place-items:center;overflow:hidden;border-radius:26px;background:#101010;color:#fff}.wallet-stage i{position:absolute;inset:0 auto 0 0;width:28%;background:linear-gradient(90deg,var(--secondary),transparent)}.wallet-stage div{position:relative;max-width:70%;text-align:center}.wallet-stage small,.mag-copy small,.editorial small{display:block;margin-bottom:8px;color:color-mix(in srgb,var(--primary) 72%, white);font-size:11px;font-weight:800;text-transform:uppercase}
      .chrome{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;border-radius:16px;border:1px solid var(--line);background:color-mix(in srgb,var(--stage) 88%, var(--primary));padding:10px 12px}.chrome b,.chrome span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chrome b{font-size:16px}.chrome span{border-radius:999px;background:color-mix(in srgb,var(--primary) 16%, transparent);padding:6px 9px;color:var(--muted);font-size:10px;font-weight:800}
      .dashboard{display:grid;height:calc(100% - 52px);min-height:0;grid-template-columns:22% 1fr;gap:14px}.dashboard aside{display:grid;align-content:start;gap:10px;border-radius:18px;background:color-mix(in srgb,var(--primary) 13%, var(--stage));padding:14px}.dashboard aside span{height:12px;border-radius:999px;background:color-mix(in srgb,var(--text) 26%, transparent)}.dashboard main{display:grid;min-width:0;gap:10px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metrics i{height:48px;border-radius:14px;background:color-mix(in srgb,var(--primary) 14%, var(--stage));border:1px solid var(--line)}.chart{display:flex;align-items:end;gap:8px;height:74px;border-radius:16px;border:1px solid var(--line);padding:12px}.chart span{flex:1;border-radius:9px;background:var(--primary)}.chart span:nth-child(2){height:70%;background:var(--secondary)}.chart span:nth-child(3){height:45%;background:var(--text)}.chart span:nth-child(4){height:90%}.table{display:grid;gap:7px}.table p{display:grid;grid-template-columns:1fr .45fr .24fr;gap:8px;margin:0}.table b,.table em,.table strong{height:12px;border-radius:999px;background:color-mix(in srgb,var(--text) 16%, transparent)}
      .magazine{display:grid;height:100%;min-height:0;grid-template-columns:.9fr 1.1fr;gap:14px}.mag-copy{display:grid;align-content:center;gap:10px}.mag-rule{width:76%;height:1px;background:var(--text)}.mag-art{position:relative;overflow:hidden;border-radius:22px;background:linear-gradient(135deg,var(--text),var(--primary));background-size:cover;background-position:center}.mag-art span{position:absolute;left:14px;right:14px;bottom:14px;border-radius:12px;background:rgba(255,255,255,.22);padding:10px;color:#fff;font-size:13px;font-weight:800;backdrop-filter:blur(10px)}
      .campaign{position:relative;height:100%;min-height:0;overflow:hidden;background:var(--secondary);display:grid;grid-template-rows:54% 46%}.campaign-image{background:var(--primary);background-size:cover;background-position:top center;filter:saturate(1.08) contrast(1.02)}.campaign-type{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;padding:24px 34px;background:var(--secondary)}.campaign-type small{position:absolute;left:34px;top:17px;color:var(--text);font-family:var(--mono),monospace;font-size:9px;font-weight:850;letter-spacing:.16em;text-transform:uppercase;opacity:.62}.campaign-type h1{color:var(--primary);font-family:var(--display),var(--body),system-ui,sans-serif;font-size:68px;line-height:.84;font-weight:950;letter-spacing:-.07em}.campaign-type span{background:var(--primary);color:var(--secondary);padding:10px 14px;font-size:14px;font-weight:750;white-space:nowrap}
      .source-card{display:grid;height:100%;min-height:0;grid-template-rows:minmax(0,1fr) auto;gap:10px}.source-image{position:relative;min-height:0;overflow:hidden;border-radius:18px;border:1px solid var(--line);background-size:cover;background-position:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28)}.source-image span{position:absolute;right:12px;top:12px;border-radius:999px;background:rgba(255,255,255,.88);color:#111827;padding:7px 10px;font-size:10px;font-weight:850;backdrop-filter:blur(10px)}.source-caption{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}.source-caption b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px}.source-caption small{color:var(--muted);font-size:10px;font-weight:850;text-transform:uppercase}
      .type-grid{height:100%;min-height:0;display:grid;align-content:space-between;overflow:hidden;border:1px solid var(--primary);background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:28px 28px;padding:18px;color:var(--primary)}.type-top{display:flex;justify-content:space-between;font-size:11px;font-weight:800}.type-top span,.axes span{border:1px solid var(--primary);border-radius:999px;padding:6px 10px;background:var(--stage)}.type-grid h1{font-size:50px;line-height:.82}.axes{display:flex;gap:8px;font-size:11px;font-weight:800}
      .lab,.event{position:relative;height:100%;min-height:0;overflow:hidden;background:#000;color:#fff;border:1px solid #262626;padding:18px}.lab{background-image:repeating-linear-gradient(90deg,rgba(255,255,255,.16) 0 1px,transparent 1px 8px),repeating-linear-gradient(0deg,rgba(255,255,255,.1) 0 1px,transparent 1px 8px)}.hud,.event-nav{display:flex;justify-content:space-between;font-size:10px;font-weight:800}.bottom{position:absolute;left:18px;right:18px;bottom:14px}.gate{position:absolute;left:18px;top:46%;background:#000;padding:9px 11px;font-size:11px;font-weight:900}.lab h1{position:absolute;right:18px;bottom:38px;max-width:64%;text-align:right;font-size:44px}.event .nodes{position:absolute;left:50%;top:22%;display:flex;flex-wrap:wrap;width:96px;transform:translateX(-50%);gap:8px;justify-content:center}.event .nodes i{width:12px;height:10px;border:1px solid #777}.event h1{position:absolute;left:22px;bottom:30px;max-width:62%;font-size:38px}.event button{position:absolute;right:22px;bottom:34px;border:0;background:#fff;color:#000;padding:12px 15px;font-weight:850}
      .editorial{position:relative;display:grid;height:100%;min-height:0;grid-template-columns:56px minmax(0,1fr) 34%;gap:16px;align-items:stretch;overflow:hidden}.editorial:before{content:"";position:absolute;left:72px;right:0;top:38%;height:1px;background:var(--line)}.editorial-rail{display:flex;flex-direction:column;justify-content:space-between;border-right:1px solid var(--line);padding-right:12px;color:var(--muted);font-size:10px;font-weight:850;text-transform:uppercase;writing-mode:vertical-rl}.editorial-copy{display:grid;align-content:center;gap:12px;min-width:0}.editorial-copy small{color:var(--muted);font-size:10px;font-weight:850;letter-spacing:.18em;text-transform:uppercase}.editorial-copy h1{font-size:54px;line-height:.86;max-width:100%;text-transform:none}.editorial-panel{position:relative;display:grid;align-content:end;gap:10px;overflow:hidden;border-radius:0;background:linear-gradient(180deg,var(--primary),color-mix(in srgb,var(--secondary) 76%, var(--stage)));padding:18px;color:var(--stage)}.editorial-panel b{max-width:100%;overflow:hidden;font-family:var(--display),var(--body),system-ui,sans-serif;font-size:18px;line-height:1.05}.editorial-panel i{display:block;height:12px;background:color-mix(in srgb,var(--stage) 60%, transparent)}.editorial-panel i:nth-of-type(2){width:70%}.editorial-panel i:nth-of-type(3){width:44%}
      @media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}}
      @media(max-width:520px){.card{padding:10px}.shell{border-radius:16px;gap:8px}.meta{padding:10px 10px 0}.chips span:nth-child(n+2){display:none}.specimen{padding:0 10px}.caption{padding:8px 10px 10px}.caption p{display:none}h1{font-size:23px}.dashboard{grid-template-columns:20% 1fr;gap:8px}.metrics i{height:30px}.chart{height:44px}.magazine,.editorial{grid-template-columns:1fr}.mag-art,.editorial-panel{display:none}.campaign-type h1{font-size:38px}.type-grid h1{font-size:32px}.lab h1,.event h1{font-size:28px}.wallet-stage div{max-width:82%}}
    </style>
  </head>
  <body>
    <section class="card">
      <div class="shell">
        <header class="meta">
          <div class="brand"><span>${escapeHtml(meta.title)}</span><small>${escapeHtml(meta.sourceHost)}</small></div>
          <div class="chips">${chips.map((item) => `<span>${escapeHtml(item!)}</span>`).join("")}</div>
        </header>
        <main class="specimen">${cardSpecimenMarkup(meta, variant, surface)}</main>
        <footer class="caption">
          <p><b>${escapeHtml(meta.profile?.visualDna?.typographySignal || meta.profile?.archetype || packageLabel(meta))}</b><span>${escapeHtml(packageLabel(meta))}</span></p>
          ${renderCardSwatches(meta)}
        </footer>
      </div>
    </section>
  </body>
</html>`;
}

export function renderWebPreview(meta: DesignMeta) {
  return injectTokenStylesheet(renderWebPreviewBody(meta), meta);
}

function renderWebPreviewBody(meta: DesignMeta) {
  if (isCanvaDesign(meta) || hasStrongScreenshot(meta)) return renderScreenshotLedWebPreview(meta);

  const previewStyle = inferPreviewStyle(meta);
  if (previewStyle === "campaign") return renderCampaignWebPreview(meta);
  if (previewStyle === "consumer-wallet") return renderConsumerWalletWebPreview(meta);
  if (previewStyle === "dark-event") return renderDarkEventWebPreview(meta);
  if (previewStyle === "immersive-experiment") return renderImmersiveWebPreview(meta);
  if (previewStyle === "type-specimen") return renderTypeSpecimenWebPreview(meta);

  const { typography } = meta.tokens;
  const colors = semanticColors(meta);
  const sourceMode = sourceModeLabel(meta, "直接网址");
  const image = firstPreviewImage(meta);
  const posterStyle = image
    ? `background:linear-gradient(180deg,rgba(0,0,0,.08),rgba(0,0,0,.42)),url('${image}');background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,${colors.primary},${colors.secondary});`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · Web Preview</title>
    <style>
      :root { --bg:${colors.surface}; --text:${colors.text}; --accent:${colors.primary}; --secondary:${colors.secondary}; --line:rgba(24,24,27,.1); }
      *{box-sizing:border-box} body{margin:0;min-height:100vh;font-family:${typography.families.primary};background:linear-gradient(180deg,color-mix(in srgb, ${colors.primary} 9%, ${colors.surface}),${colors.surface});color:var(--text)}
      main{padding:32px;display:grid;gap:24px} section,article{border-radius:28px;border:1px solid var(--line);background:rgba(255,255,255,.76);padding:24px;backdrop-filter:blur(14px)}
      .hero{display:grid;grid-template-columns:1.1fr .9fr;gap:20px;min-height:320px}.poster{border-radius:22px;background:linear-gradient(135deg,${colors.primary},${colors.secondary});color:#fff;padding:28px;display:flex;flex-direction:column;justify-content:space-between}
      .eyebrow{font-size:12px;letter-spacing:.22em;text-transform:uppercase;opacity:.8} h1,h2{margin:0;font-family:${typography.families.display}} h1{font-size:44px;line-height:1.05;letter-spacing:-.04em} h2{font-size:22px}
      p{margin:0;color:color-mix(in srgb,var(--text) 74%,white);line-height:1.55}.cta{display:inline-flex;padding:12px 16px;border-radius:999px;background:#fff;color:${colors.primary};font-weight:700}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.chip{display:inline-flex;padding:8px 10px;border-radius:999px;background:color-mix(in srgb,${colors.primary} 12%,white);color:${colors.primary};font-size:12px;font-weight:700}.swatch{height:72px;border-radius:18px;border:1px solid rgba(255,255,255,.45)}.small{font-size:12px;color:#52525b}
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <article style="display:grid;gap:20px;align-content:start;">
          <div class="eyebrow">网页衍生预览</div>
          <h1>${escapeHtml(meta.title)}</h1>
          <p>${escapeHtml(meta.summary)}</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;"><span class="chip">${escapeHtml(meta.sourceHost)}</span><span class="chip">${sourceMode}</span></div>
          <div><span class="cta">应用这套视觉语言</span></div>
        </article>
        <div class="poster" style="${posterStyle}">
          <div class="eyebrow">设计系统库</div>
          <div><div style="font-size:52px;line-height:1;font-family:${typography.families.display};">一套可复用的设计系统</div><p style="margin-top:12px;color:rgba(255,255,255,.8)">把网站气质转成可以迁移的设计协议。</p></div>
          <div class="small" style="color:rgba(255,255,255,.72)">${escapeHtml(typography.families.primary)}</div>
        </div>
      </section>
      <section>
        <div class="eyebrow" style="color:${colors.primary}">配色板</div>
        <div class="grid" style="margin-top:14px;">
          <div><div class="swatch" style="background:${colors.primary}"></div><div class="small">主色 ${colors.primary}</div></div>
          <div><div class="swatch" style="background:${colors.secondary}"></div><div class="small">辅色 ${colors.secondary}</div></div>
          <div><div class="swatch" style="background:${colors.surface}"></div><div class="small">背景 ${colors.surface}</div></div>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderScreenshotLedWebPreview(meta: DesignMeta) {
  const { typography } = meta.tokens;
  const colors = semanticColors(meta);
  const images = sourcePreviewImages(meta, 4);
  const image = bestScreenshotAsset(meta)?.path || images[0] || firstPreviewImage(meta);
  const title = sourceDisplayTitle(meta);
  const label = sourceUsageLabel(meta);
  const metaLabel = sourceMetaLabel(meta);
  const displayFont = cssFontFamily(meta.profile?.typographyRoles?.display || typography.families.display, "Arial Black, Arial, sans-serif");
  const monoFont = cssFontFamily(meta.profile?.typographyRoles?.mono || typography.families.mono, "IBM Plex Mono, ui-monospace, monospace");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · Web Derivative Preview</title>
    <style>
      :root{--surface:${colors.surface};--text:${colors.text};--primary:${colors.primary};--secondary:${colors.secondary};--neutral:${meta.tokens.colors.neutral};--display:${displayFont};--mono:${monoFont};}
      *{box-sizing:border-box}
      body{margin:0;min-height:100vh;background:var(--surface);color:var(--text);font-family:${typography.families.primary},Arial,system-ui,sans-serif}
      main{min-height:100vh;background:var(--surface)}
      .hero{position:relative;min-height:100vh;overflow:hidden;padding:clamp(20px,4vw,56px);display:grid;align-items:end}
      .photo{position:absolute;inset:0;overflow:hidden;background:var(--secondary)}
      .photo img{width:100%;height:100%;object-fit:cover;object-position:center;display:block;filter:saturate(1.04) contrast(1.02)}
      .photo:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.24),rgba(0,0,0,.08) 42%,rgba(0,0,0,.48));pointer-events:none}
      .topbar{position:absolute;z-index:2;left:clamp(22px,5vw,72px);right:clamp(22px,5vw,72px);top:clamp(18px,4vw,48px);display:flex;justify-content:space-between;align-items:center;color:#fff;font-family:var(--mono),monospace;font-weight:850;letter-spacing:-.04em;text-shadow:0 1px 18px rgba(0,0,0,.38)}
      .topbar span:last-child{letter-spacing:.16em;font-size:clamp(11px,1.3vw,14px);opacity:.86}
      .type-field{position:relative;z-index:2;width:min(760px,100%);display:grid;gap:18px;padding:clamp(18px,3vw,34px);border:1px solid rgba(255,255,255,.32);background:color-mix(in srgb,var(--surface) 78%,transparent);backdrop-filter:blur(18px);box-shadow:0 20px 64px rgba(0,0,0,.2)}
      h1{margin:0;color:var(--text);font-family:var(--display),Arial Black,Arial,sans-serif;font-size:clamp(38px,7vw,90px);line-height:.94;font-weight:900;letter-spacing:-.05em;text-wrap:balance}
      .meta-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-family:var(--mono),monospace;font-size:clamp(10px,1.2vw,13px);letter-spacing:.13em;text-transform:uppercase;color:color-mix(in srgb,var(--text) 68%,transparent)}
      .tag{border:1px solid color-mix(in srgb,var(--text) 22%,transparent);background:color-mix(in srgb,var(--primary) 14%,var(--surface));color:var(--text);padding:9px 12px;font-size:12px;line-height:1;font-weight:760;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}
      .source-grid{display:grid;grid-template-columns:repeat(${Math.min(3, Math.max(1, images.length || 1))},minmax(0,1fr));gap:14px;padding:18px clamp(20px,4vw,56px) clamp(24px,5vw,64px);background:var(--surface)}
      .thumb{aspect-ratio:16/9;overflow:hidden;background:var(--secondary);border:1px solid color-mix(in srgb,var(--text) 14%,transparent)}
      .thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:center}
      @media(max-width:760px){.hero{min-height:78vh}.type-field{width:100%}h1{font-size:clamp(38px,12vw,70px)}.source-grid{grid-template-columns:1fr}.thumb:nth-child(n+2){display:none}}
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="photo">${image ? `<img src="${image}" alt="${escapeHtml(meta.title)} source crop" />` : ""}<div class="topbar"><span>${escapeHtml(metaLabel)}</span><span>01</span></div></div>
        <div class="type-field">
          <h1>${escapeHtml(title)}</h1>
          <div class="meta-row"><span>web derivative</span><span class="tag">${escapeHtml(label)}</span><span>source-driven</span></div>
        </div>
      </section>
      <section class="source-grid" aria-label="localized source evidence">
        ${(images.length ? images : [image]).filter(Boolean).slice(1, 4).map((item) => `<div class="thumb"><img src="${item}" alt="" /></div>`).join("")}
      </section>
    </main>
  </body>
</html>`;
}

function renderCampaignWebPreview(meta: DesignMeta) {
  return renderScreenshotLedWebPreview(meta);
}

function renderDarkEventWebPreview(meta: DesignMeta) {
  const { typography } = meta.tokens;
  const heroHeading = firstHeading(meta);
  const [sessionOne = "Session one", sessionTwo = "Session two", sessionThree = "Session three"] = secondaryHeadings(meta);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · Web Preview</title>
    <style>
      :root{--bg:#000;--text:#f5f5f5;--muted:#8b8b8b;--line:#262626;--dim:#111}
      *{box-sizing:border-box}
      html{background:var(--bg)}
      body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:${typography.families.primary},ui-monospace,SFMono-Regular,Menlo,monospace}
      main{min-height:100vh;padding:18px clamp(16px,4vw,38px) 72px}
      a{color:inherit;text-decoration:none}
      .nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;font-size:10px;letter-spacing:.05em;color:#f2f2f2}
      .nav div{display:flex;gap:18px}.nav div:last-child{justify-content:flex-end}
      .constellation{height:330px;display:grid;align-content:center;justify-items:center;gap:16px;color:#fafafa}
      .row{display:flex;gap:28px}.node{width:18px;height:14px;border:1px solid #777;display:grid;place-items:center;font-size:7px;line-height:1;color:#eee;box-shadow:0 0 0 1px #000 inset}.node::before{content:"AI"}
      .hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end;border-bottom:1px solid var(--line);padding-bottom:34px}
      .hero h1{margin:0;font-family:${typography.families.display},${typography.families.primary},sans-serif;font-size:clamp(36px,7vw,70px);line-height:.92;letter-spacing:-.075em;font-weight:500;text-wrap:balance}
      .kicker{margin-top:16px;display:flex;gap:16px;flex-wrap:wrap;color:#dcdcdc;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
      .ticket{display:inline-flex;min-height:54px;align-items:center;padding:0 24px;background:#fff;color:#000;font-size:14px;font-weight:600}
      .section{display:grid;grid-template-columns:minmax(160px,.36fr) minmax(0,1fr);gap:38px;padding:70px 0;border-bottom:1px solid var(--line)}
      .section h2{margin:0;font-size:clamp(24px,3.3vw,42px);line-height:1;font-weight:450;letter-spacing:-.06em}
      .speaker{display:grid;grid-template-columns:minmax(0,1fr) 220px;border:1px solid var(--line);min-height:190px}
      .speaker-list{display:grid}.speaker-list div{padding:16px;border-bottom:1px solid var(--line);color:#bdbdbd;font-size:12px}.speaker-list b{display:block;color:#fff;font-size:13px;margin-bottom:4px}
      .portrait{background:radial-gradient(circle at 52% 30%,#e6e6e6 0 12%,#9d9d9d 13% 24%,#1c1c1c 25% 100%);filter:grayscale(1)}
      .sessions{display:grid;gap:0}.session{display:grid;grid-template-columns:.42fr minmax(0,1fr);gap:36px;padding:22px 0;border-bottom:1px solid var(--line)}.session h3{margin:0;font-size:15px;font-weight:500}.session p{margin:0;color:#9b9b9b;font-size:12px;line-height:1.55}
      .faq{display:grid;gap:0}.faq div{display:flex;justify-content:space-between;gap:18px;padding:17px 0;border-bottom:1px solid var(--line);font-size:14px}.faq span:last-child{color:#777}
      .bars{height:230px;display:grid;grid-template-columns:repeat(7,1fr);gap:18px;align-items:end;overflow:hidden}.bar{background:#1a1a1a}.bar:nth-child(1){height:88%}.bar:nth-child(2){height:70%}.bar:nth-child(3){height:100%}.bar:nth-child(4){height:38%}.bar:nth-child(5){height:100%}.bar:nth-child(6){height:38%}.bar:nth-child(7){height:88%}
      .sponsors{border:1px solid var(--line);display:grid;grid-template-columns:repeat(3,1fr);min-height:64px}.sponsors div{display:grid;place-items:center;border-right:1px solid var(--line);font-size:12px}.sponsors div:last-child{border-right:0}
      .next{padding:78px 0 40px}.next h2{font-size:26px;font-weight:450}.cities{margin-top:18px;font-size:clamp(46px,9vw,96px);line-height:1.08;letter-spacing:-.08em}.cities div{border-bottom:1px solid var(--line)}
      .footer{padding-top:40px;text-align:center;color:#fff;font-weight:700}
      @media (max-width:760px){
        main{padding-inline:16px}.constellation{height:230px}.row{gap:14px}.hero{grid-template-columns:1fr}.ticket{width:max-content}.section{grid-template-columns:1fr;gap:22px;padding:48px 0}.speaker{grid-template-columns:1fr}.portrait{height:180px}.session{grid-template-columns:1fr;gap:10px}.bars{height:160px;gap:10px}.cities{font-size:48px}
      }
    </style>
  </head>
  <body>
    <main>
      <nav class="nav" aria-label="Preview navigation"><div><a>Speakers</a><a>Schedule</a><a>FAQ</a></div><strong>${escapeHtml(meta.sourceHost)}</strong><div><a>Get a ticket</a><a>Apply</a></div></nav>
      <div class="constellation" aria-hidden="true">
        <div class="row"><span class="node"></span></div>
        <div class="row"><span class="node"></span><span class="node"></span><span class="node"></span></div>
        <div class="row"><span class="node"></span><span class="node"></span><span class="node"></span><span class="node"></span><span class="node"></span></div>
        <div class="row"><span class="node"></span><span class="node"></span><span class="node"></span><span class="node"></span><span class="node"></span><span class="node"></span></div>
      </div>
      <section class="hero">
        <div>
          <h1>${escapeHtml(heroHeading)}</h1>
          <div class="kicker"><span>${escapeHtml(meta.summary)}</span><span>${escapeHtml(meta.sourceHost)}</span></div>
        </div>
        <a class="ticket">Get your ticket -&gt;</a>
      </section>
      <section class="section">
        <h2>Featured speakers</h2>
        <div class="speaker"><div class="speaker-list"><div><b>Featured speaker</b>${escapeHtml(meta.sourceHost)}</div><div><b>Program lead</b>Source-derived session lineup</div><div><b>Session host</b>Source-derived program metadata</div></div><div class="portrait"></div></div>
      </section>
      <section class="section">
        <h2>Featured sessions</h2>
        <div class="sessions">
          <article class="session"><h3>${escapeHtml(sessionOne)}</h3><p>Keynote framing for what teams ship next: agents, infrastructure, and product velocity.</p></article>
          <article class="session"><h3>${escapeHtml(sessionTwo)}</h3><p>Dense technical programming, minimal ornament, and crisp session metadata.</p></article>
          <article class="session"><h3>${escapeHtml(sessionThree)}</h3><p>Autonomous product workflows presented with high contrast and restrained motion.</p></article>
        </div>
      </section>
      <section class="section"><h2>FAQ</h2><div class="faq"><div><span>What is this event?</span><span>+</span></div><div><span>How long does it take to hear back after I request a ticket?</span><span>+</span></div><div><span>Will this be live-streamed?</span><span>+</span></div><div><span>When will the full agenda be announced?</span><span>+</span></div></div></section>
      <div class="bars" aria-hidden="true"><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span></div>
      <section class="section"><h2>Sponsors</h2><div class="sponsors"><div>Sponsor</div><div>Sponsor</div><div>Partner</div></div></section>
      <section class="next"><h2>Next stops:</h2><div class="cities"><div>City one</div><div>City two</div><div>City three</div><div>City four</div></div></section>
      <div class="footer">${escapeHtml(meta.sourceHost)}</div>
    </main>
  </body>
</html>`;
}

export function renderPptPreview(meta: DesignMeta, options: PptPreviewOptions = {}) {
  return injectTokenStylesheet(renderPptSampleDeck(meta, options.slide), meta);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function renderPresentationGrammarPptPreview(meta: DesignMeta) {
  const { typography } = meta.tokens;
  const colors = semanticColors(meta);
  const sourceMode = sourceModeLabel(meta, "可供 create-slide 引用");
  const presentation = meta.profile?.presentationStyle;
  const image = firstPreviewImage(meta);
  const narrativeArc = takeList(presentation?.narrativeArc, [meta.profile?.openSlideGuidance.direction ?? meta.summary], 3);
  const themeRhythm = takeList(
    presentation ? [presentation.themeRhythm.paletteRule, ...presentation.themeRhythm.lightDarkPattern, ...presentation.themeRhythm.emphasisCadence] : undefined,
    meta.profile?.openSlideGuidance.layoutApproach ?? ["保留来源第一屏识别信号", "先规划节奏再进入页面布局"],
    4,
  );
  const archetypes = (presentation?.slideArchetypes.length ? presentation.slideArchetypes : [
    { name: "Source cover", use: meta.profile?.openSlideGuidance.coverApproach ?? "复现原站第一眼识别信号", construction: ["hero", "source title", "brand field"] },
    { name: "Evidence ledger", use: "解释抽象依据", construction: ["source signal", "interpreted role", "downstream rule"] },
    { name: "Checklist close", use: "验收 preserve / avoid / verify", construction: ["quality gates", "anti-patterns"] },
  ]).slice(0, 3);
  const qualityChecks = takeList(presentation?.qualityChecks, meta.profile?.methodology?.fidelityChecks ?? ["第一屏缩略图必须保留原站识别信号"], 4);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · Slide Preview</title>
    <style>
      :root{--surface:${colors.surface};--text:${colors.text};--primary:${colors.primary};--secondary:${colors.secondary};--line:rgba(15,23,42,.12)}
      *{box-sizing:border-box}
      body{margin:0;font-family:${typography.families.primary};background:#e9eef5;color:var(--text)}
      main{min-height:100vh;padding:clamp(16px,4vw,40px);display:grid;gap:18px;align-content:start}
      .slide{width:100%;max-width:1120px;margin:0 auto;aspect-ratio:16/9;border-radius:20px;overflow:hidden;border:1px solid var(--line);background:var(--surface);position:relative;box-shadow:0 20px 48px rgba(15,23,42,.12)}
      .pad{padding:clamp(24px,5vw,60px)}
      .eyebrow{font-size:clamp(10px,1.4vw,13px);letter-spacing:.18em;text-transform:uppercase;color:var(--primary);font-weight:750}
      h1,h2{margin:0;font-family:${typography.families.display};letter-spacing:-.04em;text-wrap:balance}
      h1{font-size:clamp(28px,6.5vw,68px);line-height:.98}
      h2{font-size:clamp(22px,4.2vw,46px);line-height:1.04;max-width:820px}
      p{margin:0;font-size:clamp(13px,1.9vw,20px);color:color-mix(in srgb,var(--text) 68%,transparent);line-height:1.45}
      .hero-art{position:absolute;right:0;top:0;bottom:0;width:40%;background:${image ? `linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.28)),url("${image}") center/cover` : "linear-gradient(135deg,var(--primary),var(--secondary))"}}
      .hero-art::after{content:"";position:absolute;inset:12%;border-radius:999px;background:rgba(255,255,255,.16);filter:blur(18px)}
      .cover-content{position:relative;width:64%;height:100%;display:grid;align-content:center;gap:clamp(12px,2vw,22px);padding:clamp(24px,5vw,62px)}
      .line{width:clamp(72px,12vw,140px);height:3px;background:var(--primary);margin:18px 0 0}
      .chips{display:flex;gap:10px;flex-wrap:wrap}
      .chip{font-size:clamp(10px,1.4vw,12px);padding:7px 10px;border-radius:999px;background:color-mix(in srgb,var(--primary) 13%,white);color:var(--primary);font-weight:750}
      .grammar{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:clamp(18px,3vw,34px)}
      .panel{min-width:0;border:1px solid var(--line);border-radius:16px;padding:clamp(12px,2vw,18px);background:rgba(255,255,255,.72)}
      .panel b{display:block;font-size:clamp(15px,2.2vw,24px);font-family:${typography.families.display};line-height:1.05;margin-bottom:8px;overflow-wrap:anywhere}
      .panel p,.panel li{font-size:clamp(11px,1.35vw,15px);line-height:1.45;color:color-mix(in srgb,var(--text) 66%,transparent)}
      .panel ul{margin:8px 0 0;padding-left:1.1em}.panel li+li{margin-top:5px}
      .archetypes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:clamp(18px,3vw,30px)}
      .card{min-width:0;border:1px solid var(--line);border-radius:16px;padding:clamp(12px,2vw,18px);background:color-mix(in srgb,var(--primary) 7%,white)}
      .card b{display:block;font-family:${typography.families.display};font-size:clamp(16px,2.2vw,25px);line-height:1.05;margin-bottom:8px}
      @media (max-width:680px){
        .hero-art{top:auto;left:0;width:100%;height:30%}
        .cover-content{width:100%;padding-bottom:30%;align-content:start}
        .grammar,.archetypes{grid-template-columns:1fr}
      }
    </style>
  </head>
  <body>
    <main>
      <section class="slide">
        <div class="hero-art"></div>
        <div class="cover-content">
          <div class="eyebrow">PPT 衍生预览</div>
          <h1>${escapeHtml(meta.title)}</h1>
          <p>${escapeHtml(meta.summary)}</p>
          <div class="chips"><span class="chip">${escapeHtml(meta.sourceHost)}</span><span class="chip">${sourceMode}</span></div>
        </div>
      </section>
      <section class="slide">
        <div class="pad">
          <div class="eyebrow">Presentation Grammar</div>
          <h2 style="margin-top:16px;">${escapeHtml(meta.profile?.openSlideGuidance.coverApproach ?? "先复现来源第一屏，再展开证据和组件规则。")}</h2>
          <div class="line"></div>
          <div class="grammar">
            <div class="panel"><b>叙事弧</b><ul>${narrativeArc.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
            <div class="panel"><b>主题节奏</b><ul>${themeRhythm.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
          </div>
        </div>
      </section>
      <section class="slide">
        <div class="pad">
          <div class="eyebrow">Slide Archetypes</div>
          <h2 style="margin-top:16px;">用页面原型约束排版，不用松散形容词代替设计系统。</h2>
          <div class="archetypes">
            ${archetypes
              .map(
                (item) => `<article class="card"><b>${escapeHtml(item.name)}</b><p>${escapeHtml(item.use)}</p><p>${escapeHtml(item.construction.slice(0, 4).join(" / "))}</p></article>`,
              )
              .join("")}
          </div>
          <div class="panel" style="margin-top:14px;"><b>生产检查</b><ul>${qualityChecks.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderCanvaDerivedPptPreview(meta: DesignMeta) {
  const { typography } = meta.tokens;
  const colors = semanticColors(meta);
  const images = sourcePreviewImages(meta, 4);
  const image = images[0] || firstPreviewImage(meta);
  const imageTwo = images[1] || image;
  const imageThree = images[2] || image;
  const title = sourceDisplayTitle(meta);
  const label = sourceUsageLabel(meta);
  const metaLabel = sourceMetaLabel(meta);
  const displayFont = cssFontFamily(meta.profile?.typographyRoles?.display || typography.families.display, "Arial Black, Arial, sans-serif");
  const monoFont = cssFontFamily(meta.profile?.typographyRoles?.mono || typography.families.mono, "IBM Plex Mono, ui-monospace, monospace");
  const arc = takeList(meta.profile?.presentationStyle?.narrativeArc, ["Hook", "Premise", "Proof", "Structure"], 4);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · PPT Derivative Preview</title>
    <style>
      :root{--surface:${colors.surface};--text:${colors.text};--primary:${colors.primary};--secondary:${colors.secondary};--neutral:${meta.tokens.colors.neutral};--display:${displayFont};--mono:${monoFont};}
      *{box-sizing:border-box}
      body{margin:0;background:#e9eef5;color:var(--text);font-family:${typography.families.primary},Arial,system-ui,sans-serif}
      main{min-height:100vh;padding:clamp(14px,3vw,34px);display:grid;gap:22px;align-content:start}
      .slide{position:relative;width:min(1120px,100%);aspect-ratio:16/9;margin:0 auto;overflow:hidden;background:var(--surface);box-shadow:0 22px 58px rgba(15,23,42,.13)}
      .source-img{position:absolute;inset:0;background:var(--secondary)}
      .source-img img{display:block;width:100%;height:100%;object-fit:cover;object-position:center;filter:saturate(1.04) contrast(1.02)}
      .cover:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.18),rgba(0,0,0,.04) 45%,rgba(0,0,0,.5));pointer-events:none}
      .label{position:absolute;z-index:2;left:7%;top:8%;font-family:var(--mono),monospace;color:#fff;font-size:clamp(11px,1.4vw,18px);font-weight:900;letter-spacing:-.03em;text-shadow:0 1px 18px rgba(0,0,0,.38)}
      .page{position:absolute;z-index:2;right:7%;top:8%;font-family:var(--mono),monospace;color:rgba(255,255,255,.9);font-size:clamp(10px,1vw,14px);letter-spacing:.16em;text-shadow:0 1px 18px rgba(0,0,0,.38)}
      .title-band{position:absolute;z-index:2;left:7%;right:7%;bottom:7%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:22px;align-items:end}
      h1,h2{margin:0;font-family:var(--display),Arial Black,Arial,sans-serif;font-weight:900;letter-spacing:-.055em;text-wrap:balance}
      h1{max-width:720px;color:#fff;font-size:clamp(34px,7vw,78px);line-height:.95;text-shadow:0 2px 26px rgba(0,0,0,.46)}
      .pill{border:1px solid rgba(255,255,255,.38);background:color-mix(in srgb,var(--surface) 84%,transparent);color:var(--text);padding:12px 16px;font-size:clamp(11px,1.2vw,15px);line-height:1;font-weight:750;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;backdrop-filter:blur(16px)}
      .bottom-meta{position:absolute;left:7%;bottom:3%;font-family:var(--mono),monospace;font-size:clamp(8px,.9vw,11px);letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.66);text-shadow:0 1px 14px rgba(0,0,0,.42)}
      .evidence{padding:5.6%;display:grid;grid-template-columns:1.2fr .8fr;gap:24px;background:var(--surface)}
      .frames{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      .frame{position:relative;overflow:hidden;background:var(--secondary);border:1px solid color-mix(in srgb,var(--text) 14%,transparent);min-height:0}
      .frame:before{content:"";display:block;padding-top:56.25%}
      .frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center}
      .notes{display:grid;align-content:center;gap:14px}
      .notes h2{color:var(--text);font-size:clamp(28px,4.2vw,54px);line-height:.96}
      .note{border-top:1px solid color-mix(in srgb,var(--text) 18%,transparent);padding-top:12px;font-family:var(--mono),monospace;font-size:clamp(9px,1vw,12px);line-height:1.5;letter-spacing:.08em;text-transform:uppercase;color:color-mix(in srgb,var(--text) 66%,transparent)}
      @media(max-width:760px){.title-band,.evidence{grid-template-columns:1fr}.pill{justify-self:start}.frames{grid-template-columns:1fr}.frame:nth-child(n+3){display:none}h1{font-size:42px}}
    </style>
  </head>
  <body>
    <main>
      <section class="slide cover">
        <div class="source-img">${image ? `<img src="${image}" alt="${escapeHtml(meta.title)} source crop" />` : ""}</div>
        <div class="label">${escapeHtml(metaLabel)}</div><div class="page">01</div>
        <div class="title-band">
          <h1>${escapeHtml(title)}</h1>
          <div class="pill">${escapeHtml(label)}</div>
          <div class="bottom-meta">presentation derivative / source-driven style system</div>
        </div>
      </section>
      <section class="slide evidence">
        <div class="frames">
          ${(images.length ? images : [image, imageTwo, imageThree]).filter(Boolean).slice(0, 4).map((item) => `<div class="frame"><img src="${item}" alt="" /></div>`).join("")}
        </div>
        <div class="notes">
          <div class="note">02 / source evidence</div>
          <h2>${escapeHtml(meta.profile?.openSlideGuidance?.coverApproach ?? "Preserve source-recognisable visual relationships before generating derivatives.")}</h2>
          ${arc.slice(0, 3).map((item) => `<div class="note">${escapeHtml(compactLine(item, item, 70))}</div>`).join("")}
        </div>
      </section>
    </main>
  </body>
</html>`;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function renderCampaignPptPreview(meta: DesignMeta) {
  return renderCanvaDerivedPptPreview(meta);
}

function renderConsumerWalletWebPreview(meta: DesignMeta) {
  const { typography } = meta.tokens;
  const colors = semanticColors(meta);
  const brand = sourceDisplayTitle(meta);
  const action = meta.profile?.componentSignatures[0]?.traits[0]?.replace(/^Observed labels:\s*/i, "").split("/")[0]?.trim() || "Primary action";
  const featureOne = meta.profile?.componentSignatures[0]?.name ?? "Action controls";
  const featureTwo = meta.profile?.componentSignatures[1]?.name ?? "Navigation";
  const featureThree = meta.profile?.componentSignatures[2]?.name ?? "Content system";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · Source-style Preview</title>
    <style>
      :root{--accent:${colors.primary};--support:${colors.secondary};--surface:${colors.surface};--ink:${colors.text};--stage:color-mix(in srgb,var(--ink) 92%,#000);--stage2:color-mix(in srgb,var(--ink) 82%,#000)}
      *{box-sizing:border-box}
      body{margin:0;min-height:100vh;background:var(--surface);color:var(--ink);font-family:${typography.families.primary},Inter,system-ui,sans-serif}
      main{min-height:100vh;padding:clamp(20px,4vw,48px);display:grid;gap:28px;background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 18%,#fff) 0%,var(--surface) 68%)}
      nav{display:flex;align-items:center;justify-content:space-between;gap:20px}
      .brand{display:flex;align-items:center;gap:12px;color:var(--ink);font-weight:850;font-size:clamp(24px,3vw,36px);letter-spacing:0}
      .ghost-mark{position:relative;display:inline-block;width:44px;height:30px;border-radius:56% 54% 62% 48%;background:var(--ink);transform:skewX(-14deg)}
      .ghost-mark:before,.ghost-mark:after{content:"";position:absolute;top:9px;width:5px;height:8px;border-radius:999px;background:var(--surface);transform:skewX(14deg)}
      .ghost-mark:before{left:15px}.ghost-mark:after{right:13px}
      .actions{display:flex;align-items:center;gap:12px}.download{border:0;border-radius:999px;background:var(--accent);color:var(--ink);padding:16px 34px;font-weight:750;font-size:17px}.menu{width:58px;height:58px;border-radius:999px;background:#fff;display:grid;place-items:center;border:0}.menu span,.menu:before,.menu:after{content:"";display:block;width:24px;height:2px;background:var(--ink);border-radius:999px}.menu{gap:5px}
      .stage{position:relative;min-height:clamp(620px,74vh,920px);border-radius:34px;overflow:hidden;background:
        radial-gradient(circle at 70% 12%,color-mix(in srgb,var(--accent) 24%,transparent),transparent 34%),
        linear-gradient(90deg,color-mix(in srgb,var(--support) 82%,#000) 0 19%,transparent 19%),
        linear-gradient(180deg,#141414,#0d0d0d);box-shadow:0 28px 80px rgba(15,23,42,.18)}
      .stage:before{content:"";position:absolute;inset:0;background:
        linear-gradient(90deg,color-mix(in srgb,var(--accent) 60%,transparent) 7%,transparent 8% 88%,color-mix(in srgb,var(--support) 35%,transparent) 90%,transparent 91%),
        radial-gradient(circle at 45% 44%,rgba(255,255,255,.06),transparent 28%);filter:blur(1px);opacity:.62}
      .stage:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 0 55%,rgba(0,0,0,.42));}
      .hero{position:relative;z-index:2;min-height:inherit;display:grid;place-items:center;text-align:center;padding:clamp(44px,8vw,110px)}
      .hero-inner{display:grid;justify-items:center;gap:28px;max-width:900px}.kicker{color:#f4f0ff;font-size:clamp(16px,2vw,23px);font-weight:650}.hero h1{margin:0;color:#fff;font-size:clamp(48px,8vw,104px);line-height:1.04;letter-spacing:0;font-weight:850;text-wrap:balance}.cta{display:inline-flex;align-items:center;gap:12px;border-radius:999px;background:#e7e1ff;color:var(--ink);padding:19px 36px;font-weight:760;font-size:18px}.phone{position:relative;width:13px;height:21px;border:2px solid currentColor;border-radius:4px;opacity:.78}.phone:after{content:"";position:absolute;left:50%;bottom:2px;width:3px;height:3px;border-radius:50%;background:currentColor;transform:translateX(-50%)}
      .features{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.feature{border-radius:28px;background:#fff;padding:24px;border:1px solid rgba(60,49,91,.08);min-height:170px;box-shadow:0 16px 36px rgba(60,49,91,.07)}.feature b{display:block;font-size:24px;letter-spacing:0;margin-bottom:12px}.feature p{margin:0;color:color-mix(in srgb,var(--ink) 68%,#fff);line-height:1.5}
      @media(max-width:780px){main{padding:18px}.actions .download{display:none}.stage{border-radius:26px;min-height:620px}.features{grid-template-columns:1fr}.hero h1{font-size:48px}}
    </style>
  </head>
  <body>
    <main>
      <nav>
        <div class="brand"><span>${escapeHtml(brand)}</span></div>
        <div class="actions"><button class="download">${escapeHtml(compactLine(action, "Action", 18))}</button><button class="menu" aria-label="Menu"><span></span></button></div>
      </nav>
      <section class="stage">
        <div class="hero">
          <div class="hero-inner">
            <div class="kicker">${escapeHtml(firstHeading(meta))}</div>
            <h1>${escapeHtml(meta.summary)}</h1>
            <div class="cta"><span class="phone" aria-hidden="true"></span><span>${escapeHtml(compactLine(action, "Primary action", 28))}</span></div>
          </div>
        </div>
      </section>
      <section class="features">
        <article class="feature"><b>${escapeHtml(featureOne)}</b><p>Derived from source-observed controls, hierarchy, and action placement.</p></article>
        <article class="feature"><b>${escapeHtml(featureTwo)}</b><p>Preserves source navigation, metadata, and wayfinding relationships.</p></article>
        <article class="feature"><b>${escapeHtml(featureThree)}</b><p>Uses source density, layout rhythm, and visual asset treatment.</p></article>
      </section>
    </main>
  </body>
</html>`;
}

function renderTypeSpecimenWebPreview(meta: DesignMeta) {
  const { typography } = meta.tokens;
  const colors = semanticColors(meta);
  const bg = colors.surface;
  const ink = colors.text;
  const grid = colors.secondary;
  const accent = colors.primary;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · Type Specimen Preview</title>
    <style>
      :root{--bg:${bg};--ink:${ink};--grid:${grid};--accent:${accent};--tone-a:color-mix(in srgb,var(--accent) 72%,white);--tone-b:color-mix(in srgb,var(--grid) 72%,white);--tone-c:color-mix(in srgb,var(--ink) 18%,var(--bg))}
      *{box-sizing:border-box}
      body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:${typography.families.primary},system-ui,sans-serif}
      main{min-height:100vh;background:
        linear-gradient(var(--grid) 1px,transparent 1px),
        linear-gradient(90deg,var(--grid) 1px,transparent 1px),
        var(--bg);background-size:clamp(34px,6vw,86px) clamp(34px,6vw,86px);padding:clamp(16px,3vw,34px)}
      nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:18px;font-size:clamp(13px,1.2vw,18px);font-weight:800}
      nav div:last-child{text-align:right}.pill{display:inline-flex;align-items:center;min-height:42px;border:1.5px solid var(--ink);border-radius:999px;padding:0 18px;background:var(--tone-a)}
      .hero{min-height:72vh;display:grid;align-content:end;padding-top:9vh}
      .meta{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:clamp(18px,3vw,34px)}.chip{border:1.5px solid var(--ink);border-radius:999px;padding:8px 13px;background:var(--bg);font-weight:850}.chip:nth-child(2){background:var(--tone-a);color:#000}.chip:nth-child(3){background:var(--tone-b);color:#000}
      h1{margin:0;font-family:${typography.families.display},${typography.families.primary},sans-serif;font-size:clamp(84px,22vw,290px);line-height:.72;letter-spacing:0;font-weight:900;text-transform:uppercase}
      .axis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:clamp(26px,4vw,54px)}.axis article{min-height:170px;border:1.5px solid var(--ink);background:color-mix(in srgb,var(--grid) 62%,white);padding:18px;display:grid;align-content:space-between}.axis b{font-size:clamp(42px,8vw,112px);line-height:.78;letter-spacing:0}.axis span{font-weight:850;text-transform:uppercase}
      .tester{margin-top:10px;border:1.5px solid var(--ink);background:var(--bg);padding:clamp(18px,3vw,32px);display:grid;gap:18px}.tester .label{display:flex;justify-content:space-between;font-weight:850}.sample{font-size:clamp(48px,9vw,128px);line-height:.86;font-weight:800;letter-spacing:0}
      .features{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:10px}.feature{border:1.5px solid var(--ink);min-height:150px;padding:16px;background:var(--bg)}.feature:nth-child(2){background:var(--accent)}.feature:nth-child(3){background:var(--tone-a)}.feature:nth-child(4){background:var(--tone-b)}.feature b{display:block;font-size:24px;margin-bottom:10px}.feature p{margin:0;line-height:1.35;font-weight:650}
      @media(max-width:820px){nav{grid-template-columns:1fr}.axis,.features{grid-template-columns:1fr}.hero{min-height:auto}h1{font-size:82px}.sample{font-size:54px}}
    </style>
  </head>
  <body>
    <main>
      <nav><div>${escapeHtml(meta.sourceHost)}</div><strong>${escapeHtml(sourceDisplayTitle(meta))}</strong><div><span class="pill">Specimen</span></div></nav>
      <section class="hero">
        <div class="meta"><span class="chip">Display</span><span class="chip">Body</span><span class="chip">Metadata</span></div>
        <h1>${escapeHtml(sourceDisplayTitle(meta)).replace(/\s+/g, "<br/>")}</h1>
      </section>
      <section class="axis">
        <article><span>Display</span><b>Type</b></article>
        <article><span>Body</span><b>Text</b></article>
        <article><span>Meta</span><b>001</b></article>
      </section>
      <section class="tester"><div class="label"><span>Source Specimen</span><span>Role / Scale / Rhythm</span></div><div class="sample">${escapeHtml(firstHeading(meta))}</div></section>
      <section class="features">
        <article class="feature"><b>Display</b><p>Source-derived headline behavior.</p></article>
        <article class="feature"><b>Body</b><p>Source-derived reading density.</p></article>
        <article class="feature"><b>Metadata</b><p>Source-derived labels and chrome.</p></article>
        <article class="feature"><b>Review</b><p>Unknown typography remains marked.</p></article>
      </section>
    </main>
  </body>
</html>`;
}

function renderImmersiveWebPreview(meta: DesignMeta) {
  const { typography } = meta.tokens;
  const image = firstPreviewImage(meta);
  const imageLayer = image ? `background-image:linear-gradient(180deg,rgba(0,0,0,.18),rgba(0,0,0,.74)),url('${image}');` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(meta.title)} · Immersive Preview</title>
    <style>
      :root{--bg:#080808;--text:#fff;--muted:#8a8a8a;--line:rgba(255,255,255,.42)}
      *{box-sizing:border-box}
      html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:${typography.families.primary},Arial,sans-serif}
      main{position:relative;min-height:100vh;overflow:hidden;background:#080808}
      .stage{position:absolute;inset:0;${imageLayer}background-size:cover;background-position:center;filter:contrast(1.12) saturate(.85)}
      .stage:before{content:"";position:absolute;inset:0;background:
        repeating-linear-gradient(90deg,rgba(255,255,255,.08) 0 1px,transparent 1px 5px),
        repeating-linear-gradient(0deg,rgba(255,255,255,.055) 0 1px,transparent 1px 7px);
        mix-blend-mode:screen;opacity:.32}
      .stage:after{content:"";position:absolute;inset:-20%;background:
        linear-gradient(115deg,transparent 0 32%,rgba(255,255,255,.16) 33%,transparent 34% 100%),
        repeating-radial-gradient(circle at 56% 44%,rgba(255,255,255,.2) 0 1px,transparent 1px 8px);
        transform:skewX(-8deg);opacity:.36;mix-blend-mode:overlay}
      .hud{position:relative;z-index:2;min-height:100vh;padding:clamp(22px,4vw,48px);display:grid;grid-template-rows:auto 1fr auto;letter-spacing:-.05em}
      .top,.bottom{display:grid;grid-template-columns:1fr auto 1fr;gap:22px;align-items:start;font-size:clamp(11px,1.25vw,18px);font-weight:750;text-transform:uppercase}
      .top div:last-child,.bottom div:last-child{text-align:right}
      .brand{display:flex;align-items:center;gap:12px}.rule{display:inline-block;width:1px;height:1.15em;background:#fff;opacity:.7}
      .center{display:grid;place-items:center;text-align:center}
      .gate{display:inline-block;background:rgba(0,0,0,.58);padding:10px 14px;font-size:clamp(14px,2.4vw,30px);font-weight:800;letter-spacing:-.08em;text-transform:uppercase}
      h1{position:absolute;right:clamp(22px,4vw,48px);top:50%;max-width:min(760px,64vw);margin:0;transform:translateY(-50%);font-size:clamp(46px,11vw,168px);line-height:.78;letter-spacing:-.12em;text-align:right;font-weight:900;text-transform:uppercase}
      .panel{position:absolute;left:clamp(22px,4vw,48px);top:18%;z-index:3;width:min(420px,42vw);font-size:clamp(11px,1vw,15px);line-height:1.48;color:#f4f4f4}
      .panel b{display:block;margin-bottom:8px;text-transform:uppercase}.panel p{margin:0 0 16px}.panel .separator{height:1px;background:rgba(255,255,255,.56);margin:18px 0}
      .bottom{align-items:end}.speed{display:inline-flex;gap:12px;align-items:center}.tiny{color:#d6d6d6}
      @media(max-width:760px){.top,.bottom{grid-template-columns:1fr;gap:8px}.top div:last-child,.bottom div:last-child{text-align:left}.panel{position:relative;top:auto;left:auto;width:auto;align-self:end}.hud{gap:40px}.center{place-items:start}.gate{margin-top:30vh}h1{position:relative;right:auto;top:auto;transform:none;max-width:none;text-align:left}}
    </style>
  </head>
  <body>
    <main>
      <div class="stage" aria-hidden="true"></div>
      <div class="hud">
        <div class="top">
          <div class="brand">${escapeHtml(sourceDisplayTitle(meta))} <span class="rule"></span> LAB</div>
          <div>${escapeHtml(sourceUsageLabel(meta))}</div>
          <div>${escapeHtml(meta.sourceHost)}</div>
        </div>
        <div class="center"><div class="gate">[:: CLICK TO ENTER ::]</div></div>
        <h1>${escapeHtml(sourceDisplayTitle(meta))}</h1>
        <section class="panel">
          <b>Source-derived experiment</b>
          <p>${escapeHtml(meta.summary)}</p>
          <b>Interaction &amp; motion</b>
          <p>Source-observed motion, layering, and interaction translated into a derivative preview.</p>
          <div class="separator"></div>
          <p><b>Source-derived immersive specimen</b></p>
        </section>
        <div class="bottom">
          <div>00:00:00</div>
          <div class="tiny">HOLD FOR SPEED</div>
          <div class="speed"><span>CLICK FOR SPEED</span><span class="rule"></span><span>1:00x</span></div>
        </div>
      </div>
    </main>
  </body>
</html>`;
}
