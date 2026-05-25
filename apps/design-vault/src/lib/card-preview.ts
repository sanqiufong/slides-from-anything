import { buildModelRequestDiagnostics, chatCompletionsUrl, fetchModelEndpoint, modelGenerationControls, modelRequestHeaders, modelTemperatureControl } from "./model-request";
import { getModelRuntimeConfig, loadLocalModelEnv } from "./model-config";
import { runCliCompletion } from "./cli-executor";
import { normalizeHtmlPreview } from "./html-preview";
import { renderCardPreview, renderPptPreview } from "./preview";
import { getModelConfig, modelResponseError } from "./synthesis";
import { compileTokenStylesheet } from "./token-stylesheet";
import type { DesignMeta } from "./types";

const CARD_PROMPT_VERSION = "style-card-html-v6-grid-primitives";
const PPT_PROMPT_VERSION = "ppt-deck-html-v7-grid-primitives";
const REQUIRED_PPT_SLIDES = ["title", "data", "image", "single", "multi"] as const;

const PPT_LAYOUT_CONTRACT = {
  purpose: "Objective container, content-budget, and legibility constraints for PPT preview generation. These rules must not override source-derived color, typography, component shape, image treatment, spacing character, or motion evidence.",
  canvas: {
    logicalSize: "1920x1080",
    cssPreviewSize: "1120x630",
    aspectRatio: "16:9",
    rule: "Every .dv-ppt-slide must render as one complete fixed-ratio slide with no internal scroll and no essential content outside the frame.",
  },
  safeArea: {
    default: "Keep essential text and controls inside an equivalent 96px horizontal / 72px vertical safe area on the 1920x1080 logical canvas.",
    densePageMinimum: "Dense pages may reduce safe area, but essential text must never touch the slide edge.",
  },
  scaleReadability: [
    "Slides must remain understandable when scaled into a preview card: title, primary module, color relationship, and type character should still be legible.",
    "If content pressure is high, shorten visible text before reducing type to unreadable sizes.",
    "Use overflow hidden or line clamps for non-essential copy; do not rely on browser scrolling.",
  ],
  graphicWorkflow: [
    "When the subject contains workflow, progress, supply chain, pipeline, agent handoff, review gate, risk, or human-in-the-loop signals, represent the main idea as a diagram first: nodes, lanes, connectors, status chips, and simple inline CSS icons.",
    "Keep each workflow node to one short label plus one compact metric/status; move reasons and explanations into small secondary notes.",
    "Use icon-like primitives from CSS and text initials only; do not import icon libraries or remote SVGs.",
    "A process/progress page should be readable by scanning shapes before reading paragraphs.",
  ],
  styleBoundary: [
    "Use the Design Vault abstraction for palette, font family, hierarchy, component geometry, image treatment, and motion.",
    "Do not introduce new dominant colors, fonts, decorative effects, or generic dashboard/card systems that are not supported by the design-system context.",
  ],
  pageTypes: [
    {
      id: "title",
      objective: "Verify opening hierarchy and source recognition.",
      required: ["short title", "one-line subtitle", "source/chapter marker"],
      optional: ["one visual or graphic field"],
      budget: "No more than one title, one subtitle, and three compact metadata/chrome items.",
    },
    {
      id: "data",
      objective: "Verify numeric hierarchy and evidence modules.",
      required: ["page title", "3-4 metrics", "one-line note per metric"],
      optional: ["simple chart or source marker"],
      budget: "No more than four metrics and one simple chart-like structure.",
    },
    {
      id: "image",
      objective: "Verify image crop, visual field, and text/image relationship.",
      required: ["page title", "one dominant image or graphic field", "2-3 thumbnails or annotations"],
      optional: ["short caption"],
      budget: "Keep image boundaries explicit; text must not be hidden by imagery.",
    },
    {
      id: "single",
      objective: "Verify one-module text hierarchy.",
      required: ["one headline", "one short body", "one source note"],
      optional: ["small label or rule"],
      budget: "Body copy should be roughly 40-70 CJK characters or 18-35 English words.",
    },
    {
      id: "multi",
      objective: "Verify repeated module, workflow, or progress behavior with graphic scanning before paragraph reading.",
      required: ["page title", "3-5 modules or workflow nodes", "clear grouping or flow direction"],
      optional: ["source marker", "status chips", "simple inline CSS icons"],
      budget: "Each module/node gets one short title plus one compact status or one short line only.",
    },
  ],
} as const;

class PptDeckValidationError extends Error {
  override name = "PptDeckValidationError";
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function assetEvidenceScore(asset: DesignMeta["assets"][number]) {
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

function assetContext(meta: DesignMeta) {
  return meta.assets
    .map((asset, index) => ({ asset, index, score: assetEvidenceScore(asset) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 18)
    .map(({ asset, score }) => ({
      name: asset.name,
      kind: asset.kind,
      // Bundle-root-relative path. The model sees this verbatim and (faithfully)
      // emits it as `<img src="assets/foo.png">` in the rendered HTML. A
      // `<base href=".../file/">` injected at serve time anchors it to whichever
      // host (local dev, community server) is rendering.
      url: asset.path,
      sourceUrl: asset.sourceUrl,
      evidenceScore: score,
    }));
}

function annotateFallbackHtml(html: string, reason: string) {
  const safeReason = reason.replace(/--/g, "-").replace(/\s+/g, " ").trim();
  return `<!-- Design Vault PPT model fallback: ${safeReason} -->\n${html}`;
}

function validatePptDeckHtml(html: string) {
  if (!/class\s*=\s*["'][^"']*\bdv-ppt-slide\b/i.test(html)) {
    throw new PptDeckValidationError("PPT deck generation missing .dv-ppt-slide sections.");
  }

  const missingSlides = REQUIRED_PPT_SLIDES.filter((id) => !new RegExp(`data-slide\\s*=\\s*["']${id}["']`, "i").test(html));
  if (missingSlides.length > 0) {
    throw new PptDeckValidationError(`PPT deck generation missing required slides: ${missingSlides.join(", ")}.`);
  }

  if (/<(?:img|source|video|audio|iframe)\b[^>]+\s(?:src|srcset)\s*=\s*["']https?:\/\//i.test(html)) {
    throw new PptDeckValidationError("PPT deck generation referenced remote media instead of local Design Vault assets.");
  }

  if (/<link\b[^>]+href\s*=\s*["']https?:\/\//i.test(html)) {
    throw new PptDeckValidationError("PPT deck generation referenced remote CSS or font assets.");
  }

  if (!/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce/i.test(html)) {
    throw new PptDeckValidationError("PPT deck generation missing a prefers-reduced-motion fallback.");
  }

  if (!/overflow(?:-x|-y)?\s*:\s*(?:hidden|clip)/i.test(html)) {
    throw new PptDeckValidationError("PPT deck generation missing overflow containment for fixed-size preview slides.");
  }
}

/**
 * Inject the W1.3 token stylesheet into an AI-generated HTML document so
 * `.dv-*` utility classes and `--dv-*` vars resolve. We splice the
 * stylesheet into the first `<head>` we find (the AI almost always emits
 * one); if there's no head, we prepend the stylesheet to the body. The
 * result is that `var(--dv-color-brand)` etc. always have a value in the
 * iframe regardless of what the AI did with its own `<style>` block.
 */
function withTokenStylesheet(html: string, meta: DesignMeta): string {
  const styleBlock = compileTokenStylesheet(meta.profile);
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${styleBlock}\n</head>`);
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n${styleBlock}`);
  }
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, (m) => `${m}\n${styleBlock}`);
  }
  return `${styleBlock}\n${html}`;
}

export async function generateStyleCardPreview(meta: DesignMeta) {
  if (meta.sourceMode === "canva-template" || meta.sourceMode === "canva-editor") {
    return {
      html: renderCardPreview(meta),
      mode: "fallback" as const,
      reason: "Canva imports render deterministic source-driven previews; model text is used for abstraction only, not for the visual card.",
    };
  }

  loadLocalModelEnv();
  const runtime = getModelRuntimeConfig();
  const config = getModelConfig();
  const useLocalCli = runtime.mode === "local-cli" && runtime.localCli !== null;

  if (!useLocalCli && !config) {
    return {
      html: renderCardPreview(meta),
      mode: "fallback" as const,
      reason: "No model runtime configured for style-card generation.",
    };
  }

  const system = `You are a senior visual designer generating one static HTML preview card for a design-system library.
Return only a complete HTML document. Do not explain. Do not output markdown.
The card must be a visual artifact that demonstrates the design style, not a report about the style.`;
  const user = {
    task: "Generate one standalone HTML style card from this Design Vault design-system context.",
    canvas: {
      width: 800,
      height: 500,
      rule: "The visible design must fit exactly inside an 800x500 canvas with no scrolling, no clipped text, and no content outside the frame.",
    },
    contentRules: [
      // ── PRIORITY -1 (highest): Closed option set + Pre-flight ──
      "CLOSED OPTION SET: when slideArchetypes / componentSignatures / antiPatterns / compositionSignatures.'GRID PRIMITIVES' are populated, treat them as the ONLY allowed vocabulary. SELECT one slideArchetype to anchor the card's composition; do NOT invent a new layout. SELECT components from componentSignatures by their `.classname` traits; do NOT invent component classes. SELECT grid containers from compositionSignatures GRID PRIMITIVES by their `.classname`; do NOT write inline `grid-template-columns`. AntiPatterns are HARD CONSTRAINTS — every visible element must pass every antiPattern check before emission.",
      "PREFER DOCUMENTED LAYOUTS: slideArchetypes whose names look like specific named patterns (e.g. 'Hero Cover', 'P1 · Cover · 封面页', 'Data Poster', 'Pipeline') are UPSTREAM-AUTHORED. Archetypes named 'Title layout sample' / 'Data display sample' / 'Image display sample' / 'Single-module text sample' / 'Multi-module text sample' are GENERIC PLACEHOLDERS — only fall back to these when NO upstream-authored layout fits the card's intent. Choosing a placeholder when an authored layout exists is a fidelity failure.",
      "EXECUTE, DO NOT COMPOSE: when slideArchetypes[N].construction[] is populated, those lines are EXECUTION STEPS the upstream author documented for this exact layout. Follow each step verbatim. Construction text starting with '骨架:' / '关键类:' / '动效 recipe:' / '网格规则:' are MACHINE-READABLE DIRECTIVES, not prose — implement them literally.",
      "GRID PRIMITIVES ARE FIXED VOCABULARY: per §1.4 of the upstream methodology, every multi-column or matrix layout MUST use one of the documented `.grid-*` (or analogous) class names listed in compositionSignatures under the 'GRID PRIMITIVES' header. Writing inline `grid-template-columns: ...` on a content container is a fidelity failure — the column ratio + gap + alignment have already been tuned. If no listed preset matches your intent, pick the closest one and adapt CONTENT, not the grid.",
      "PRE-FLIGHT BEFORE HTML: before emitting any HTML tags, output a single line `<!-- DV-PREFLIGHT: layout=<chosen archetype name>; components=<csv of selected .classname>; grids=<csv of selected .grid-* / .swiss-* classnames>; antiPatterns_audited=<csv of P0 rule titles you verified>; posture=<token semantic posture> -->`. The HTML must be CONSISTENT with this preflight — if you commit to layout X with grids Y and antiPattern Z, the body must honor all three. This single comment makes your design decisions auditable.",
      // ── PRIORITY 0: do not render evidence text as visible card content ──
      "EVIDENCE IS NOT CONTENT. visualDna.colorAtmosphere / typographySignal / layoutGrammar / componentLanguage are PROFILER NOTES describing how the source feels — they exist to inform YOUR design choices, not to be printed as paragraphs on the card. NEVER copy these strings into <p>, <h*>, or any visible element. The card must SHOW style, not WORDS ABOUT style. If you find yourself rendering a sentence longer than 10 words, the card is failing.",
      "FORBIDDEN PHRASES on the visible card: 'Imported font candidates', 'unresolved variables', 'evidence-backed', 'capabilities require human review', 'inferred from', 'mark confidence low', 'source-recognisable', any sentence about CSS variables. These are debug strings — they must never reach the rendered card body.",
      "VISIBLE WORD BUDGET: brand/source name (≤4 words) + ONE short headline (≤8 words) + up to 3 tiny labels or numbers. NO paragraphs. NO multi-sentence body text. Most of the card should be color fields, type, and composition — not text.",
      // ── PRIORITY 1: posture-driven composition ──
      "POSTURE CONTRACT: tokens.semantic.posture (one of restrained / expressive / dramatic / playful) MUST dictate the composition pattern. Each posture demands different choices — see the posturePresets payload field. A 'dramatic' posture rendered as a calm muted card is a failure; a 'restrained' posture rendered with garish bouncy motion is a failure.",
      "STYLE ANCHOR — colors: MUST set the canvas background to var(--dv-bg). When --dv-color-role-hero exists AND its hex differs from --dv-bg, the hero color MUST fill a substantial color field on the card (≥30% area on dramatic, ≥15% on expressive, ≥0% on restrained). When --dv-color-role-deep-section exists, render it as a closing band, footer strip, or column. When --dv-color-role-alt-section exists, use it for an interlude/divider element.",
      "STYLE ANCHOR — typography: MUST use var(--dv-font-display) for the headline and var(--dv-font-body) for any small label. The headline font-family resolution is provided to you; you don't pick a family. Headline size MUST reflect tokens.primitive.fontSize — for dramatic posture use a size at or near tokens.primitive.fontSize.3xl; for restrained, use no larger than tokens.primitive.fontSize.xl. Letter-spacing and weight should match the posture (dramatic → tight + 900 weight; restrained → normal + 400-500).",
      "STYLE ANCHOR — motion: tokens.primitive.duration carries the source's actual tempo. Use var(--dv-duration-base) for the primary transition. Restrained: opacity fade only. Expressive: subtle transform + opacity. Dramatic: scaleX or translateX bands using emphasized easing var(--dv-easing-emphasized). Playful: cubic-bezier with overshoot. Always include @media (prefers-reduced-motion: reduce) to disable motion.",
      // ── PRIORITY 2: token discipline ──
      "DESIGN-VAULT TOKEN DISCIPLINE: a `<style>` block with `--dv-color-…`, `--dv-bg`, `--dv-text-primary`, `--dv-accent`, `--dv-radius-card`, `--dv-motion-tap`, etc. plus a utility class set (`.dv-bg`, `.dv-bg-accent`, `.dv-text`, `.dv-text-accent`, `.dv-rounded-card`, `.dv-rounded-button`, `.dv-motion-tap`, …) WILL BE PREPENDED to your output. Use those tokens and classes for ALL colors, radii, motion durations, and easing. Never emit raw `#hex`, `Npx` for radius, or `Nms` for motion — use `var(--dv-color-brand)`, `var(--dv-radius-card)`, `var(--dv-motion-tap)`, etc.",
      "colorRoles.accentPalette enumerates the saturated identity colors. The compiled stylesheet emits each accentPalette entry as BOTH its free-form slug (`--dv-color-<role>`) AND a canonical alias (`--dv-color-role-hero`, `--dv-color-role-persistent-chrome`, `--dv-color-role-alt-section`, `--dv-color-role-deep-section`, `--dv-color-role-accent`, `--dv-color-role-muted`, `--dv-color-role-decorative`). PREFER the canonical aliases — they're guaranteed cross-site stable.",
      // ── PRIORITY 3: composition ──
      "Compose a single polished specimen appropriate to the source category that feels source-recognisable but is not a screenshot copy.",
      "Do not improve, reinterpret, or beautify the source according to personal preference; only generalize what is supported by assets, tokens, profile, or source evidence.",
      "If evidence is weak, create a restrained evidence-backed specimen and leave style claims implicit instead of guessing a stronger style.",
      "Show style through typography scale, rhythm, color fields, component shapes, image treatment, spacing, and composition.",
      "If componentMotionRecipes are present, demonstrate one source-derived micro-interaction or reveal with inline CSS only, and include a prefers-reduced-motion fallback. Use `var(--dv-motion-tap)` / `var(--dv-motion-reveal)` durations.",
      "Use inline CSS for layout-specific structure that isn't covered by the DV utility classes. No external CSS, no JavaScript, no remote network requests. You may use provided local asset URLs.",
      "Use overflow:hidden on html/body and the root canvas.",
      "Avoid generic product cards unless the source evidence or package capabilities explicitly support that structure.",
      // ── PRIORITY 4: output cleanliness ──
      "OUTPUT FORMAT: respond with ONLY the HTML document. NO preamble like 'Here is the complete HTML document:'. NO markdown fences. NO commentary. The first non-whitespace character of your response MUST be `<` (the start of <!doctype or <html or <style).",
    ],
    posturePresets: {
      hint: "Use posture from tokens.semantic.posture to pick the composition pattern.",
      restrained: "Calm editorial. Canvas = warm/neutral bg. Headline at fontSize.xl or smaller, weight 400-500, normal letter-spacing. ONE accent only as a hairline rule or small dot. Multi-column when alt-section exists. Motion = opacity fade only. Think Monocle, Apartamento, MIT Tech Review.",
      expressive: "Modern marketing. Bold headline at fontSize.2xl, weight 600-700. Use accent.primary for ONE CTA fill. 1-2 visible component shapes. Subtle hover lift at var(--dv-motion-tap). Think Stripe, Linear, Vercel.",
      dramatic: "Cinematic / bold. Hero canonical color fills ≥40% of canvas as a solid block. Headline at fontSize.3xl, weight 800-950, tight letter-spacing (-0.04em). Use emphasized easing for transitions. NO rounded corners on primary blocks (radius-button or 0). Often: half-and-half color split, or color block on left + dense info on right. Think Swiss International, Massimo Vignelli, IKB-era posters.",
      playful: "Bouncy. cubic-bezier(.5,1.7,.3,.95) on transitions. Rounded radii at modal level. Slight rotation (≤3deg) on accent elements. Multiple accent colors visible. Think Linear's Y2K refreshes, Notion's whimsy.",
    },
    styleAnchorContract: {
      hint: "Concrete style anchors to read off profile.tokens + profile.colorRoles before composing.",
      colorRules: [
        "Canvas: always declare `background: var(--dv-bg);` on the root element.",
        "Hero block: if `--dv-color-role-hero` resolves to a value distinct from `--dv-bg`, render it as a dominant color field — size depends on posture.",
        "Deep section: if `--dv-color-role-deep-section` exists, use it for a footer band or closing column.",
        "Alt section: if `--dv-color-role-alt-section` exists, use it for an interlude or divider element.",
        "Accent: use `--dv-color-role-accent` (or `--dv-accent`) for CTAs, dots, links — never for backgrounds larger than ~10% of canvas (unless the source actually uses accent as the dominant ground, which is rare).",
      ],
      typographyRules: [
        "Headline element MUST use `font-family: var(--dv-font-display);`.",
        "Body / labels MUST use `font-family: var(--dv-font-body);`.",
        "Headline font-size: read from `tokens.primitive.fontSize` — match the upper end of the scale for dramatic, mid for expressive, lower for restrained.",
      ],
    },
    tokenStylesheetWillBePrependedByHost: true,
    tokenStylesheetPreview: compileTokenStylesheet(meta.profile).slice(0, 1200) + "…",
    designSystemContext: {
      title: meta.title,
      sourceHost: meta.sourceHost,
      sourceMode: meta.sourceMode,
      summary: meta.summary,
      packageType: meta.packageManifest?.packageType,
      capabilities: meta.capabilities?.slice(0, 8),
      tokens: meta.tokens,
      profile: {
        systemName: meta.profile.systemName,
        archetype: meta.profile.archetype,
        visualThesis: meta.profile.visualThesis,
        visualDna: meta.profile.visualDna,
        previewStrategy: meta.profile.previewStrategy,
        colorRoles: meta.profile.colorRoles,
        typographyRoles: meta.profile.typographyRoles,
        spacingSystem: meta.profile.spacingSystem,
        compositionSignatures: meta.profile.compositionSignatures,
        componentSignatures: meta.profile.componentSignatures.slice(0, 6),
        componentMotionRecipes: meta.profile.componentMotionRecipes?.slice(0, 6),
        interactionModel: meta.profile.interactionModel,
        antiPatterns: meta.profile.antiPatterns,
        openSlideGuidance: meta.profile.openSlideGuidance,
        presentationStyle: meta.profile.presentationStyle,
      },
      localAssets: assetContext(meta),
      localAssetOrdering: "Assets are ordered by generic visual-evidence priority: hero/cover/background/source imagery first, then brand marks, then lower-confidence icons.",
    },
    outputContract: {
      format: "complete HTML document",
      width: "800px",
      height: "500px",
      rootSelector: ".style-card",
      promptVersion: CARD_PROMPT_VERSION,
    },
  };

  try {
    if (useLocalCli && runtime.localCli) {
      const result = await runCliCompletion({
        agentId: runtime.localCli.agentId,
        model: runtime.localCli.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
        jsonOutput: false,
        timeoutMs: runtime.timeoutMs,
        failureLabel: "Style card generation (local CLI) failed",
      });
      return {
        html: withTokenStylesheet(normalizeHtmlPreview(result.content, `${meta.title} style card`), meta),
        mode: "model" as const,
        model: `${result.agentId}:${result.model}`,
      };
    }

    if (!config) {
      throw new Error("No model runtime configured for style-card generation.");
    }

    const endpoint = chatCompletionsUrl(config.baseUrl);
    const maxTokens = 4096;
    const retries = 1;
    const requestBody = {
      model: config.model,
      ...modelTemperatureControl(config.model, 0.55),
      ...modelGenerationControls(config.model, maxTokens, config.baseUrl),
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    };
    const response = await fetchModelEndpoint(endpoint, {
      method: "POST",
      headers: modelRequestHeaders(config.apiKey),
      body: JSON.stringify(requestBody),
    }, {
      timeoutMs: config.timeoutMs,
      retries,
      retryDelayMs: 1200,
      failureLabel: "Style card generation failed",
      diagnostics: buildModelRequestDiagnostics({
        label: "Style card generation failed",
        endpoint,
        model: config.model,
        body: requestBody,
        timeoutMs: config.timeoutMs,
        retries,
        maxTokens,
        promptVersion: CARD_PROMPT_VERSION,
        messageContents: [system, JSON.stringify(user)],
      }),
    });

    if (!response.ok) throw new Error(await modelResponseError(response));

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Style card generation returned empty content.");

    return {
      html: withTokenStylesheet(normalizeHtmlPreview(content, `${meta.title} style card`), meta),
      mode: "model" as const,
      model: config.model,
    };
  } catch (error) {
    return {
      html: renderCardPreview(meta),
      mode: "fallback" as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function compactText(value: string | undefined, limit: number) {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function pptTextMaterials(meta: DesignMeta) {
  const slideArchetypes = meta.profile.presentationStyle?.slideArchetypes ?? [];
  const components = meta.profile.componentSignatures ?? [];
  const moduleSources = [
    ...slideArchetypes.map((item) => ({ title: item.name, body: item.use })),
    ...components.map((item) => ({ title: item.name, body: item.role })),
  ];
  const modules = (moduleSources.length ? moduleSources : [
    { title: "Title hierarchy", body: meta.profile.openSlideGuidance.coverApproach || meta.summary },
    { title: "Source evidence", body: "Use extracted assets, colors, and component roles as proof points." },
    { title: "Image treatment", body: meta.profile.presentationStyle?.imageRules?.[0] || meta.profile.visualDna?.layoutGrammar || meta.summary },
  ]).slice(0, 5);
  return {
    deckTitle: compactText(meta.profile.systemName || meta.title, 64),
    sourceHost: compactText(meta.sourceHost, 44),
    visualThesis: compactText(meta.profile.visualThesis, 150),
    summary: compactText(meta.summary, 150),
    coverTitle: compactText(meta.title, 54),
    coverSubtitle: compactText(meta.profile.openSlideGuidance.coverApproach || meta.summary, 112),
    sourceNote: compactText(meta.profile.openSlideGuidance.direction || meta.sourceHost || meta.sourceUrl, 86),
    metrics: [
      { label: "assets", value: String(meta.assets.length), note: "localized source material" },
      { label: "capabilities", value: String(meta.capabilities?.length ?? meta.profile.componentSignatures.length), note: "routed design uses" },
      { label: "colors", value: String(Object.values(meta.tokens.colors).filter(Boolean).length), note: "token roles" },
      { label: "gates", value: String(meta.profile.antiPatterns.length), note: "fidelity checks" },
    ],
    modules: modules.map((item) => ({
      title: compactText(item.title, 42),
      body: compactText(item.body, 86),
    })),
    imageCaption: compactText(meta.profile.presentationStyle?.imageRules?.[0] || meta.profile.visualDna?.layoutGrammar || "Source visual treatment", 86),
  };
}

function slideContentPlan(meta: DesignMeta) {
  const textMaterials = pptTextMaterials(meta);
  return [
    {
      id: "title",
      name: "Cover",
      goal: "Create a source-recognisable opening slide inside the fixed preview canvas. Let the design system choose the visual treatment.",
      requiredElements: ["source name/title", "one short source-grounded subtitle", "1-3 compact metadata/chrome items", "best available local source visual if it supports recognition", "one visible source-derived motion/reveal"],
      layoutContractId: "title",
      contentBudget: "One short title, one subtitle, one source marker, optional visual field.",
      content: {
        title: textMaterials.coverTitle,
        subtitle: textMaterials.coverSubtitle,
        sourceHost: textMaterials.sourceHost,
        motionRecipes: meta.profile.componentMotionRecipes?.slice(0, 3),
      },
    },
    {
      id: "data",
      name: "Data / Evidence",
      goal: "Show extraction evidence as a slide while keeping metric count and text length inside the fixed preview canvas.",
      requiredElements: ["four metrics", "short labels", "visual comparison rhythm or chart-like treatment"],
      layoutContractId: "data",
      contentBudget: "Three to four metrics; each metric gets one short label and one short note.",
      content: {
        metrics: textMaterials.metrics,
      },
    },
    {
      id: "image",
      name: "Image / Asset",
      goal: "Demonstrate how the source's image or graphic language fits a slide without hiding essential text.",
      requiredElements: ["dominant image or graphic field", "supporting thumbnails or fragments", "short label"],
      layoutContractId: "image",
      contentBudget: "One dominant visual field, two to three support items, one short caption.",
      content: {
        imageRules: meta.profile.presentationStyle?.imageRules?.slice(0, 4),
        localAssetCount: meta.assets.length,
        imageCaption: textMaterials.imageCaption,
      },
    },
    {
      id: "single",
      name: "Single Module Text",
      goal: "Lay out one content module using the source's actual type hierarchy while preserving readable text scale.",
      requiredElements: ["one headline", "one short body", "source-like metadata"],
      layoutContractId: "single",
      contentBudget: "One headline and one short body; trim text before shrinking type below readability.",
      content: {
        headline: textMaterials.modules[0]?.title || "Single module",
        body: textMaterials.modules[0]?.body || textMaterials.visualThesis,
      },
    },
    {
      id: "multi",
      name: "Workflow / Module System",
      goal: "Arrange repeated modules, process steps, or progress states as a graphic system with scan-first nodes and minimal explanatory text.",
      requiredElements: ["3-4 modules or workflow nodes", "source-like grouping", "flow direction or status rhythm", "simple inline CSS icons or node markers"],
      layoutContractId: "multi",
      contentBudget: "Three to five modules/nodes; each item has one short title plus one compact status or one short line.",
      content: {
        modules: textMaterials.modules.slice(0, 5),
      },
    },
  ];
}

export async function generatePptDeckPreview(meta: DesignMeta) {
  const fallbackHtml = renderPptPreview(meta);
  const textMaterials = pptTextMaterials(meta);
  const slidePlan = slideContentPlan(meta);
  loadLocalModelEnv();
  const runtime = getModelRuntimeConfig();
  const config = getModelConfig();
  const useLocalCli = runtime.mode === "local-cli" && runtime.localCli !== null;

  if (!useLocalCli && !config) {
    const reason = "No model runtime configured for PPT deck generation.";
    return {
      html: annotateFallbackHtml(fallbackHtml, reason),
      mode: "fallback" as const,
      reason,
    };
  }

  const system = `You are a senior presentation designer generating source-grounded slide HTML.
Return only a complete HTML document. Do not explain. Do not output markdown.
You must design the slides from the abstracted style system and the requested slide goals. Avoid generic templates.
Use objective layout constraints only to make the preview fit the fixed slide canvas; never use them to replace source-derived color, typography, component language, image treatment, or motion.`;
  const user = {
    task: "Generate a five-slide PPT derivative preview from this Design Vault design-system context.",
    canvas: {
      logicalSlideWidth: 1920,
      logicalSlideHeight: 1080,
      previewSlideWidth: 1120,
      previewSlideHeight: 630,
      rule: "Every .dv-ppt-slide must be exactly 1120x630 CSS pixels in this HTML preview, representing a 1920x1080 16:9 PPT canvas. No slide-internal scrolling, no clipped essential text.",
    },
    layoutContract: PPT_LAYOUT_CONTRACT,
    textMaterials,
    designSystemContext: {
      title: meta.title,
      sourceUrl: meta.sourceUrl,
      sourceHost: meta.sourceHost,
      sourceMode: meta.sourceMode,
      summary: meta.summary,
      packageType: meta.packageManifest?.packageType,
      tokens: meta.tokens,
      profile: {
        systemName: meta.profile.systemName,
        archetype: meta.profile.archetype,
        confidence: meta.profile.confidence,
        visualThesis: meta.profile.visualThesis,
        visualDna: meta.profile.visualDna,
        colorRoles: meta.profile.colorRoles,
        typographyRoles: meta.profile.typographyRoles,
        spacingSystem: meta.profile.spacingSystem,
        compositionSignatures: meta.profile.compositionSignatures,
        componentSignatures: meta.profile.componentSignatures.slice(0, 6),
        componentMotionRecipes: meta.profile.componentMotionRecipes?.slice(0, 6),
        interactionModel: meta.profile.interactionModel,
        antiPatterns: meta.profile.antiPatterns,
        openSlideGuidance: meta.profile.openSlideGuidance,
        presentationStyle: meta.profile.presentationStyle,
      },
      capabilities: meta.capabilities?.slice(0, 8),
      localAssets: assetContext(meta),
      localAssetOrdering: "Assets are ordered by generic visual-evidence priority: hero/cover/background/source imagery first, then brand marks, then lower-confidence icons.",
    },
    slidePlan,
    contentRules: [
      // ── PRIORITY -1 (highest): Closed option set + Pre-flight ──
      "CLOSED OPTION SET: when slideArchetypes / componentSignatures / antiPatterns / compositionSignatures.'GRID PRIMITIVES' are populated, treat them as the ONLY allowed vocabulary. Pick FIVE slideArchetypes total — one for each required slide (title, data, image, single, multi); do NOT invent new layouts. SELECT components from componentSignatures by their `.classname` traits. SELECT grid containers from compositionSignatures GRID PRIMITIVES by their `.classname`; do NOT write inline `grid-template-columns`. AntiPatterns are HARD CONSTRAINTS — every slide must pass every antiPattern check before emission.",
      "DATA-SLIDE LABEL ≠ ARCHETYPE NAME: the required `data-slide=\"title|data|image|single|multi\"` attributes are CONTAINER TAGS for the validator, NOT a directive to use the 'Title/Data/Image/Single/Multi layout sample' generic archetype. For each of the 5 required slides, pick the MOST FITTING UPSTREAM-AUTHORED archetype (e.g. for the title-tagged slide, prefer 'P1 · Cover · 封面页' or '开场封面 (Hero Cover)' over 'Title layout sample'). Only fall back to the generic sample archetype when NO upstream-authored layout fits.",
      "EXECUTE, DO NOT COMPOSE: when slideArchetypes[N].construction[] is populated, those lines are EXECUTION STEPS the upstream author documented for this exact layout. Follow each step verbatim. Construction text starting with '骨架:' / '关键类:' / '动效 recipe:' / '网格规则:' are MACHINE-READABLE DIRECTIVES — implement them literally. presentationStyle.themeRhythm.lightDarkPattern gives the slide-type sequence; honor it across the 5 slides.",
      "GRID PRIMITIVES ARE FIXED VOCABULARY: per §1.4 of the upstream methodology, every multi-column or matrix layout on every slide MUST use one of the documented `.grid-*` / `.swiss-*` / `.split*` class names listed in compositionSignatures under the 'GRID PRIMITIVES' header. Writing inline `grid-template-columns: ...` on a content container is a fidelity failure — the column ratio + gap + alignment have already been tuned. If no listed preset matches, pick the closest one and adapt CONTENT, not the grid.",
      "PRE-FLIGHT BEFORE HTML: before emitting any HTML, output a single line `<!-- DV-PREFLIGHT: slides=[<5 slug labels: title-archetype/data-archetype/...>], components=[<csv of selected .classname>], grids=[<csv of selected .grid-* / .swiss-* classnames used across the 5 slides>], antiPatterns_audited=[<csv of P0 rule titles>], rhythm=[<5 slide-type tags from themeRhythm.lightDarkPattern>], posture=<token semantic posture> -->`. The deck must be CONSISTENT with this preflight — every commitment in the manifest must be honored in the HTML. This makes your design decisions auditable.",
      // ── PRIORITY 0: do not render evidence text as visible slide content ──
      "EVIDENCE IS NOT CONTENT. visualDna.colorAtmosphere / typographySignal / layoutGrammar / componentLanguage are PROFILER NOTES describing how the source feels — they exist to inform YOUR design choices, not to be printed as paragraphs on the slides. NEVER copy these strings into <p>, <h*>, or any visible element. Each slide must SHOW style, not WORDS ABOUT style.",
      "FORBIDDEN PHRASES on visible slides: 'Imported font candidates', 'unresolved variables', 'evidence-backed', 'capabilities require human review', 'inferred from', 'mark confidence low', 'source-recognisable', any sentence about CSS variables. These are debug strings — they must never reach the rendered deck.",
      // ── PRIORITY 1: posture-driven composition ──
      "POSTURE CONTRACT: tokens.semantic.posture (one of restrained / expressive / dramatic / playful) MUST dictate the deck's overall composition. Every slide must reflect that posture. See the posturePresets payload field for concrete guidance. A 'dramatic' source rendered as a calm muted deck is a failure; a 'restrained' source rendered with garish bouncy motion is a failure.",
      "STYLE ANCHOR — colors: EVERY slide MUST set its background to var(--dv-bg) (not white default). When --dv-color-role-hero exists AND its hex differs from --dv-bg, AT LEAST ONE slide (typically the title) MUST render that color as ≥50% area on dramatic posture, ≥25% on expressive, ≥10% on restrained. When --dv-color-role-deep-section exists, one slide (typically the closer) should use it as the dominant ground. When --dv-color-role-alt-section exists, use it for at least one interlude slide.",
      "STYLE ANCHOR — typography: All headlines MUST use var(--dv-font-display); all body / labels MUST use var(--dv-font-body); mono labels MUST use var(--dv-font-mono). Headline sizes scale to posture — for dramatic, the title slide headline must be at tokens.primitive.fontSize.3xl or larger (use clamp() for previews). For restrained, no headline exceeds tokens.primitive.fontSize.2xl.",
      "STYLE ANCHOR — motion: tokens.primitive.duration is the source's actual tempo. Use var(--dv-duration-base) for slide entrance, var(--dv-duration-emphasized) for chart/data reveals. Posture maps motion choice: restrained = opacity fade only; dramatic = scaleX bands using var(--dv-easing-emphasized); playful = spring bounce; expressive = subtle transform + opacity.",
      // ── PRIORITY 2: existing rules ──
      "Treat layoutContract as the hard boundary for canvas, page type, text budget, and preview legibility. It is not a visual style guide.",
      "Let the abstracted design system determine layout, background, type scale, color, spacing, and image placement.",
      "colorRoles.accentPalette (when present) is the authoritative palette — every saturated identity color from the source is enumerated there with role and coverage hints. Distribute these values across the deck: one slide may anchor on accentPalette[0] as the dominant panel fill, another on accentPalette[1] for hero type, decorative markers from accentPalette[2+], and so on. Never render an all-white slide when accentPalette has saturated entries; never collapse a multi-color source to a single accent.",
      "If accentPalette includes a 'hero-fill' or 'oversized-display-type' entry, AT LEAST one slide (typically title or image) must render that color as a large field — not as a small chip.",
      "Use only textMaterials and slidePlan for visible words. You may shorten text to fit; do not expand it into explanatory prose.",
      "Use componentMotionRecipes as executable animation guidance. Each generated deck should visibly apply at least one recipe as CSS animation, staged reveal, active-state choreography, or persistent chrome behavior.",
      "Translate source interaction into presentation language: hover becomes staged emphasis, sticky becomes persistent slide chrome, scroll/animation becomes slide-enter or masked reveal, tabs/accordion/dialog become before/after or active-state choreography.",
      "DO NOT use the deterministic Design Vault sample look: no default white dashboard, no default blue/red bars, no gray logo placeholder panels unless those are source-supported.",
      "Use the source's dominant background relationship first. If the source is black/full-bleed/oversized serif, the slides should inherit that relationship.",
      "Use provided local asset URLs only; never use remote URLs, external CSS, JavaScript, or icon libraries.",
      "If a required source image is not available, reconstruct the composition with source-grounded color fields, typography, and simple CSS shapes, and avoid pretending the missing image exists.",
      "Visible text should be real slide content from slidePlan, not a design-system report or prompt commentary.",
      "Every slide section must include class=\"dv-ppt-slide\" and data-slide equal to one of: title, data, image, single, multi.",
      "Every .dv-ppt-slide must set width:1120px, height:630px, position:relative, overflow:hidden, box-sizing:border-box, and aspect-ratio:16/9.",
      "Use stable internal layout tracks with minmax(0, 1fr), min-width:0, and min-height:0 where needed so text, media, and modules cannot push the slide wider or taller.",
      "If a title, paragraph, caption, or module body risks overflow, reduce the copy or clamp non-essential lines; do not shrink essential type until it becomes unreadable in a card preview.",
      "When a slide is about workflow, pipeline, process progress, agent handoff, review, risk, or human intervention, make the first visual read a diagram: 3-6 nodes, connectors, status badges, and simple CSS icons. Do not make the main surface a stack of paragraph cards.",
      "Use paragraph copy only as secondary annotation on workflow pages. The core progress should be visible from module shape, icon, step number, connector, color state, and status chip.",
      "Keep HTML self-contained with inline CSS only. The outer document may stack slides vertically with a neutral viewer background.",
      "Include @media (prefers-reduced-motion: reduce) so motion can settle instantly for reduced-motion users.",
      // ── PRIORITY 3: output cleanliness ──
      "OUTPUT FORMAT: respond with ONLY the HTML document. NO preamble like 'Here is the complete HTML document:'. NO markdown fences. NO commentary. The first non-whitespace character of your response MUST be `<` (the start of <!doctype or <html or <style).",
    ],
    posturePresets: {
      hint: "Use tokens.semantic.posture to pick the deck's overall composition mood. Every slide must reflect that mood — color fields, typography weight, motion type all derive from it.",
      restrained: "Calm editorial deck. Slides are warm/neutral bg-default. Headlines at fontSize.xl or smaller, weight 400-500, normal letter-spacing. Hairline rules between sections. ONE accent per slide max. Motion = opacity fade only. Think Monocle Magazine, MIT Tech Review.",
      expressive: "Modern marketing deck. Bold headlines at fontSize.2xl, weight 600-700. One slide uses accent.primary as CTA block. Subtle entrance transform + opacity. Think Stripe, Linear, Vercel.",
      dramatic: "Cinematic / bold deck. AT LEAST TITLE + ONE INTERLUDE slide must be ≥50% dominated by --dv-color-role-hero or --dv-color-role-deep-section. Headlines at fontSize.3xl or above, weight 800-950, tight letter-spacing (-0.04em). NO rounded corners on primary blocks. Scale/clip bands with emphasized easing. Half-and-half color splits encouraged. Think Swiss International, Massimo Vignelli, IKB posters, Bauhaus.",
      playful: "Bouncy deck. cubic-bezier(.5,1.7,.3,.95) transitions. Rounded radii at modal level. Slight rotation (≤3deg) on accent elements. Multiple accent colors visible across slides. Think Linear Y2K, Notion whimsy.",
    },
    styleAnchorContract: {
      hint: "Hard rules each slide must satisfy — read off profile.tokens + profile.colorRoles before composing.",
      slideBackgroundRules: [
        "Slide bg: declare `background: var(--dv-bg);` on EVERY .dv-ppt-slide. Even when bg is pure white, declare it explicitly so the variable resolves.",
        "TITLE slide: if --dv-color-role-hero exists AND differs from --dv-bg, the hero color MUST fill ≥50% area on dramatic posture (≥25% expressive, ≥10% restrained). If hero === bg, use accent.primary as a hero block instead.",
        "INTERLUDE / IMAGE slide: when --dv-color-role-alt-section exists, use it for at least one slide's dominant ground or sidebar.",
        "CLOSER slide (if 5+ slides): when --dv-color-role-deep-section exists, use it as the dominant ground (footer-like). Use inverse text color.",
      ],
      typographyRules: [
        "Headlines: font-family: var(--dv-font-display); font-size scaled to posture's high end.",
        "Body / labels: font-family: var(--dv-font-body); font-size at tokens.primitive.fontSize.sm or base.",
        "Mono labels (eyebrows, captions): font-family: var(--dv-font-mono); font-size at tokens.primitive.fontSize.xs.",
      ],
    },
    outputContract: {
      format: "complete HTML document",
      slideSelector: ".dv-ppt-slide",
      requiredSlides: REQUIRED_PPT_SLIDES,
      promptVersion: PPT_PROMPT_VERSION,
    },
  };

  try {
    if (useLocalCli && runtime.localCli) {
      const result = await runCliCompletion({
        agentId: runtime.localCli.agentId,
        model: runtime.localCli.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
        jsonOutput: false,
        timeoutMs: positiveNumber(process.env.DESIGN_VAULT_PPT_PREVIEW_TIMEOUT_MS, Math.max(runtime.timeoutMs, 600_000)),
        failureLabel: "PPT deck generation (local CLI) failed",
      });
      return {
        html: normalizeHtmlPreview(result.content, `${meta.title} PPT deck`),
        mode: "model" as const,
        model: `${result.agentId}:${result.model}`,
      };
    }

    if (!config) {
      throw new Error("No model runtime configured for PPT deck generation.");
    }

    const endpoint = chatCompletionsUrl(config.baseUrl);
    const maxTokens = positiveNumber(process.env.DESIGN_VAULT_PPT_PREVIEW_MAX_TOKENS, 8192);
    const timeoutMs = positiveNumber(process.env.DESIGN_VAULT_PPT_PREVIEW_TIMEOUT_MS, Math.max(config.timeoutMs, 600_000));
    const retries = 0;
    let validationFeedback: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const messages = [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
        ...(validationFeedback
          ? [
              {
                role: "user",
                content: `The previous PPT HTML failed validation: ${validationFeedback}. Regenerate the full complete HTML document now. Include all required .dv-ppt-slide sections with data-slide values: ${REQUIRED_PPT_SLIDES.join(", ")}. Do not omit any slide. Preserve the source-derived design system, but obey the fixed 1120x630 slide canvas, overflow containment, short text budgets, and reduced-motion fallback.`,
              },
            ]
          : []),
      ];
      const requestBody = {
        model: config.model,
        ...modelTemperatureControl(config.model, 0.55),
        ...modelGenerationControls(config.model, maxTokens, config.baseUrl),
        messages,
      };
      const response = await fetchModelEndpoint(endpoint, {
        method: "POST",
        headers: modelRequestHeaders(config.apiKey),
        body: JSON.stringify(requestBody),
      }, {
        timeoutMs,
        retries,
        retryDelayMs: 1200,
        failureLabel: "PPT deck generation failed",
        diagnostics: buildModelRequestDiagnostics({
          label: "PPT deck generation failed",
          endpoint,
          model: config.model,
          body: requestBody,
          timeoutMs,
          retries,
          maxTokens,
          promptVersion: `${PPT_PROMPT_VERSION}-attempt-${attempt}`,
          messageContents: messages.map((message) => message.content),
        }),
      });

      if (!response.ok) throw new Error(await modelResponseError(response));

      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("PPT deck generation returned empty content.");
      const html = normalizeHtmlPreview(content, `${meta.title} PPT deck`);
      try {
        validatePptDeckHtml(html);
      } catch (error) {
        if (error instanceof PptDeckValidationError && attempt === 1) {
          validationFeedback = error.message;
          continue;
        }
        throw error;
      }

      return {
        html,
        mode: "model" as const,
        model: config.model,
      };
    }

    throw new Error("PPT deck generation failed validation after repair attempt.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      html: annotateFallbackHtml(fallbackHtml, reason),
      mode: "fallback" as const,
      reason,
    };
  }
}
