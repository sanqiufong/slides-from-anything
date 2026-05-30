import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { BehaviorSignal, ComponentMotionRecipe, DesignEvidence, DesignMeta, DesignSystemProfile, DesignTokens, ProfileTokensSemantic } from "./types";
import { getModelRuntimeConfig, loadLocalModelEnv, type LocalCliSelection } from "./model-config";
import { runCliCompletion } from "./cli-executor";
import {
  buildModelRequestDiagnostics,
  chatCompletionsUrl,
  fetchModelEndpoint,
  getModelRequestDiagnostics,
  modelGenerationControls,
  modelJsonResponseControl,
  modelRequestHeaders,
  modelTemperatureControl,
  withModelRequestDiagnostics,
  type ModelRequestDiagnostics,
} from "./model-request";
import { requiredPresentationSampleArchetypes, withRequiredPresentationSampleArchetypes } from "./presentation-samples";
import { CANONICAL_ROLE_GUIDE, slugForPrimitive, toCanonicalRole } from "./role-taxonomy";
import { buildMotionChoreography, motionChoreographyEnabled } from "./motion-choreography";

export type ModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  requireModel: boolean;
  timeoutMs: number;
};

const PROMPT_VERSION = "design-system-profile-v13-canonical-roles-evidence-primitives";
const DEFAULT_SYNTHESIS_MAX_TOKENS = 4096;

type SynthesisOptions = {
  mediaBaseDir?: string;
};

function envFlag(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

export function getModelConfig(): ModelConfig | null {
  loadLocalModelEnv();
  const apiKey = process.env.DESIGN_VAULT_MODEL_API_KEY;
  const baseUrl = process.env.DESIGN_VAULT_MODEL_BASE_URL;
  const model = process.env.DESIGN_VAULT_MODEL_NAME || "gpt-4.1";
  const requireModel = envFlag(process.env.DESIGN_VAULT_REQUIRE_MODEL);
  const timeoutMs = Number(process.env.DESIGN_VAULT_MODEL_TIMEOUT_MS ?? 120000);
  if (!apiKey || !baseUrl) return null;
  return { apiKey, baseUrl, model, requireModel, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 120000 };
}

function parseModelErrorBody(raw: string) {
  try {
    const parsed = JSON.parse(raw) as {
      error?: string | { message?: string; type?: string; code?: string };
      message?: string;
      metadata?: { limitName?: string; workspace?: string };
    };
    const error = parsed.error;
    const message = typeof error === "string" ? error : error?.message || parsed.message;
    const type = typeof error === "object" ? error.type || error.code : undefined;
    const metadata = parsed.metadata?.limitName ? `limit=${parsed.metadata.limitName}` : "";
    return [type, message, metadata].filter(Boolean).join(" · ");
  } catch {
    return raw.trim();
  }
}

export async function modelResponseError(response: Response) {
  const raw = await response.text().catch(() => "");
  const detail = parseModelErrorBody(raw).slice(0, 800);
  if (response.status === 429) {
    return `Model synthesis failed: HTTP 429 quota/rate limit${detail ? ` · ${detail}` : ""}`;
  }
  if (response.status === 401 || response.status === 403) {
    return `Model synthesis failed: HTTP ${response.status} authentication/permission error${detail ? ` · ${detail}` : ""}`;
  }
  return `Model synthesis failed: HTTP ${response.status}${detail ? ` · ${detail}` : ""}`;
}

function modelRequired() {
  return envFlag(process.env.DESIGN_VAULT_REQUIRE_MODEL);
}

function synthesisMaxTokens() {
  const value = Number(process.env.DESIGN_VAULT_MODEL_SYNTHESIS_MAX_TOKENS ?? DEFAULT_SYNTHESIS_MAX_TOKENS);
  return Number.isFinite(value) ? Math.max(2048, value) : DEFAULT_SYNTHESIS_MAX_TOKENS;
}

function synthesisRetries() {
  const value = Number(process.env.DESIGN_VAULT_MODEL_RETRIES ?? 3);
  return Number.isFinite(value) ? Math.max(0, Math.min(5, Math.round(value))) : 3;
}

function synthesisRetryDelayMs() {
  const value = Number(process.env.DESIGN_VAULT_MODEL_RETRY_DELAY_MS ?? 1800);
  return Number.isFinite(value) ? Math.max(250, Math.min(10_000, Math.round(value))) : 1800;
}

function modelMediaInputsEnabled() {
  return process.env.DESIGN_VAULT_MODEL_MEDIA_INPUTS !== "0";
}

function evidenceStats(evidence: DesignEvidence) {
  return {
    headings: evidence.headings.length,
    buttons: evidence.buttonLabels.length,
    links: evidence.linkLabels.length,
    colors: evidence.colorCandidates.length,
    fonts: evidence.fontCandidates.length,
    sections: evidence.sections?.length ?? 0,
    behaviorSignals: evidence.behaviorSignals?.length ?? 0,
    responsiveSignals: evidence.responsiveSignals?.length ?? 0,
    visualSteps: evidence.visualCrossCheck?.steps.length ?? 0,
  };
}

function withSynthesisTrace(
  profile: DesignSystemProfile,
  evidence: DesignEvidence,
  synthesis: DesignSystemProfile["synthesis"],
): DesignSystemProfile {
  return {
    ...profile,
    synthesis: {
      ...profile.synthesis,
      ...synthesis,
      promptVersion: synthesis.promptVersion ?? PROMPT_VERSION,
      evidenceStats: synthesis.evidenceStats ?? evidenceStats(evidence),
    },
  };
}

function fallbackWithTrace(
  evidence: DesignEvidence,
  tokens: DesignTokens,
  status: "model-skipped" | "model-failed" | "heuristic-only",
  reason: string,
  durationMs?: number,
  modelRequest?: ModelRequestDiagnostics,
): DesignSystemProfile {
  return withSynthesisTrace(fallbackProfile(evidence, tokens), evidence, {
    mode: "heuristic",
    status,
    reason,
    durationMs,
    required: modelRequired(),
    modelRequest,
  });
}

function evidenceCorpus(evidence: DesignEvidence) {
  return [
    evidence.sourceHost,
    evidence.title,
    evidence.description,
    evidence.headings.join(" "),
    evidence.buttonLabels.join(" "),
    evidence.linkLabels.join(" "),
    evidence.fontCandidates.join(" "),
    (evidence.visualCrossCheck?.representativeSummary ?? []).join(" "),
    (evidence.visualCrossCheck?.dominantColors ?? []).map((color) => `${color.value} ${color.roleHint ?? ""}`).join(" "),
    (evidence.sections ?? []).map((section) => `${section.role} ${section.label} ${section.textSample}`).join(" "),
    evidence.notes.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function uniqueStrings(items: Array<string | undefined | null>, limit = 8) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function slugId(input: string, fallback = "motion") {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  return normalized || fallback;
}

function motionSignalPriority(signal: BehaviorSignal) {
  const kindScore: Record<BehaviorSignal["kind"], number> = {
    animation: 10,
    transition: 9,
    hover: 8,
    carousel: 7,
    state: 7,
    tabs: 6,
    accordion: 6,
    dialog: 6,
    sticky: 5,
    fixed: 5,
    "scroll-snap": 5,
    form: 4,
    unknown: 0,
  };
  const confidenceScore = signal.confidence === "high" ? 3 : signal.confidence === "medium" ? 2 : 1;
  return (kindScore[signal.kind] ?? 0) * 10 + confidenceScore;
}

function isNoisyMotionSignal(signal: BehaviorSignal) {
  const corpus = `${signal.selector} ${signal.evidence}`.toLowerCase();
  return /w-webflow-badge|grecaptcha|cookie|pixel|tracking|intercom|launcher|skip-link/.test(corpus);
}

function motionComponentForSignal(signal: BehaviorSignal, components: DesignSystemProfile["componentSignatures"]) {
  const selector = signal.selector.toLowerCase();
  const matchByName = (pattern: RegExp) => components.find((component) => pattern.test(`${component.name} ${component.role}`.toLowerCase()))?.name;
  if (/btn|button|cta|link|action/.test(selector) || signal.kind === "hover") return matchByName(/action|button|cta|control/) ?? "Action controls";
  if (/nav|menu|header|tab|breadcrumb/.test(selector) || signal.kind === "tabs") return matchByName(/nav|metadata|tab|wayfinding/) ?? "Navigation and metadata";
  if (/card|tile|panel|item|project|work|case/.test(selector) || signal.kind === "carousel") return matchByName(/content|media|card|project/) ?? "Content and media sections";
  if (/form|input|select|textarea/.test(selector) || signal.kind === "form") return matchByName(/form|input/) ?? "Form controls";
  if (/dialog|modal|popover|drawer/.test(selector) || signal.kind === "dialog") return "Overlay surfaces";
  return components[0]?.name ?? "Source component";
}

function motionRoleForSignal(signal: BehaviorSignal) {
  if (signal.kind === "hover") return "micro feedback";
  if (signal.kind === "transition") return "state transition";
  if (signal.kind === "animation") return "keyframed motion";
  if (signal.kind === "sticky" || signal.kind === "fixed") return "scroll anchoring";
  if (signal.kind === "scroll-snap") return "scroll choreography";
  if (signal.kind === "tabs" || signal.kind === "accordion" || signal.kind === "dialog" || signal.kind === "carousel" || signal.kind === "state") return "state choreography";
  if (signal.kind === "form") return "input feedback";
  return "interaction feedback";
}

function motionTriggerForSignal(signal: BehaviorSignal) {
  if (signal.kind === "hover") return "hover/focus-visible";
  if (signal.kind === "sticky" || signal.kind === "fixed" || signal.kind === "scroll-snap") return "scroll";
  if (signal.kind === "animation") return "source animation / slide-enter";
  if (signal.kind === "tabs" || signal.kind === "accordion" || signal.kind === "dialog" || signal.kind === "carousel" || signal.kind === "state") return "state-change";
  if (signal.kind === "form") return "focus / validation";
  return "state-change";
}

function motionStatePairForSignal(signal: BehaviorSignal) {
  if (signal.kind === "hover") return "default -> hover/focus-visible";
  if (signal.kind === "accordion") return "collapsed -> expanded";
  if (signal.kind === "dialog") return "closed -> open";
  if (signal.kind === "carousel") return "inactive slide -> active slide";
  if (signal.kind === "tabs") return "inactive tab -> selected tab";
  if (signal.kind === "form") return "empty/default -> focused/validated";
  if (signal.kind === "sticky" || signal.kind === "fixed") return "flowing -> pinned";
  if (signal.kind === "scroll-snap") return "between sections -> snapped section";
  if (signal.kind === "animation") return "off-canvas / initial -> animated state";
  return "default -> active/current";
}

function motionPropertiesFromEvidence(signal: BehaviorSignal) {
  const corpus = `${signal.selector} ${signal.evidence}`.toLowerCase();
  const properties = [
    /transform|translate|scale|rotate/.test(corpus) ? "transform" : undefined,
    /opacity|fade/.test(corpus) ? "opacity" : undefined,
    /color|background|fill|stroke/.test(corpus) ? "color" : undefined,
    /shadow|elevation/.test(corpus) ? "shadow" : undefined,
    /filter|blur/.test(corpus) ? "filter" : undefined,
    /clip-path|mask|overflow/.test(corpus) ? "mask/clip" : undefined,
    /height|width|max-height|size/.test(corpus) ? "size" : undefined,
    /position|sticky|fixed/.test(corpus) ? "position" : undefined,
  ];
  const detected = uniqueStrings(properties, 5);
  if (detected.length) return detected;
  if (signal.kind === "animation") return ["keyframes", "transform", "opacity"];
  if (signal.kind === "sticky" || signal.kind === "fixed") return ["position", "translation", "layering"];
  if (signal.kind === "tabs" || signal.kind === "accordion" || signal.kind === "dialog" || signal.kind === "carousel") return ["visibility", "position", "active indicator"];
  if (signal.kind === "form") return ["outline", "border", "validation color"];
  return ["opacity", "transform", "color"];
}

function motionDurationFromEvidence(signal: BehaviorSignal, tokens: DesignTokens) {
  const match = signal.evidence.match(/(?:duration|transition|animation)[^;:]*:?\s*[^;]*?(\d+(?:\.\d+)?m?s)/i) ?? signal.evidence.match(/\b\d+(?:\.\d+)?m?s\b/i);
  return match?.[1] ?? match?.[0] ?? tokens.motion.transition;
}

function motionChoreographyForSignal(signal: BehaviorSignal) {
  if (signal.kind === "animation") return ["Preserve the source timing curve as a visible entrance or ambient state.", "Keep the movement attached to the same component role."];
  if (signal.kind === "hover") return ["Use a compact emphasis shift on the target only.", "Avoid page-wide motion for a local hover signal."];
  if (signal.kind === "sticky" || signal.kind === "fixed") return ["Keep metadata or navigation visually anchored while content changes.", "Use layer contrast rather than decorative floating."];
  if (signal.kind === "carousel" || signal.kind === "scroll-snap") return ["Move between modules with directional continuity.", "Keep image/text order aligned to source sections."];
  if (signal.kind === "tabs" || signal.kind === "accordion" || signal.kind === "dialog" || signal.kind === "state") return ["Animate the state boundary, not the entire slide.", "Make active/current state visible after the motion settles."];
  return ["Confirm state change with minimal movement.", "Keep motion functional and source-recognisable."];
}

function pptAdapterForSignal(signal: BehaviorSignal) {
  if (signal.kind === "hover") return ["Translate hover feedback into a staged highlight or CTA emphasis.", "Show the hovered state as the settled visual on one slide object."];
  if (signal.kind === "animation") return ["Use the recipe for slide-enter timing, masked image reveal, or title reveal.", "Do not add unrelated decorative loops."];
  if (signal.kind === "sticky" || signal.kind === "fixed") return ["Represent sticky behavior as persistent slide chrome.", "Keep anchored metadata in the same position across related slides."];
  if (signal.kind === "carousel" || signal.kind === "scroll-snap") return ["Use directional slide-to-slide continuity or staggered module reveals.", "Preserve source ordering and viewport rhythm."];
  if (signal.kind === "tabs" || signal.kind === "accordion" || signal.kind === "dialog" || signal.kind === "state") return ["Represent state changes as before/after panels or active indicators.", "Animate only the changing layer in previews."];
  if (signal.kind === "form") return ["Use focus/validation styling as a static micro-state in product slides.", "Avoid inventing submission flows without source evidence."];
  return ["Use as a short reveal or state confirmation in PPT previews."];
}

function recipeFromBehaviorSignal(signal: BehaviorSignal, index: number, tokens: DesignTokens, components: DesignSystemProfile["componentSignatures"]): ComponentMotionRecipe {
  const component = motionComponentForSignal(signal, components);
  const id = slugId(`${component}-${signal.kind}-${index + 1}`, `motion-${index + 1}`);
  return {
    id,
    component,
    role: motionRoleForSignal(signal),
    trigger: motionTriggerForSignal(signal),
    statePair: motionStatePairForSignal(signal),
    properties: motionPropertiesFromEvidence(signal),
    timing: {
      duration: motionDurationFromEvidence(signal, tokens),
      easing: tokens.motion.easing,
    },
    choreography: motionChoreographyForSignal(signal),
    cssHint: signal.kind === "transition" || signal.kind === "animation" ? `${signal.selector} { ${signal.evidence} }` : `${signal.selector} :: ${signal.evidence}`,
    pptAdapter: pptAdapterForSignal(signal),
    evidence: [`${signal.source}:${signal.selector}`, signal.evidence],
    confidence: signal.confidence,
  };
}

function fallbackMotionRecipe(evidence: DesignEvidence, tokens: DesignTokens, components: DesignSystemProfile["componentSignatures"]): ComponentMotionRecipe {
  const hasMotion = evidence.interactionSignals.hasAnimations || evidence.interactionSignals.hasTransitions || evidence.interactionSignals.hasHoverStyles;
  const component = components[0]?.name ?? "Source component";
  return {
    id: "source-compatible-reveal",
    component,
    role: hasMotion ? "source-compatible preview reveal" : "minimal accessible feedback",
    trigger: hasMotion ? "slide-enter / state-change" : "focus-visible / state-change",
    statePair: hasMotion ? "initial -> settled source state" : "default -> accessible active state",
    properties: hasMotion ? ["opacity", "transform", "color"] : ["outline", "opacity"],
    timing: {
      duration: tokens.motion.transition,
      easing: tokens.motion.easing,
    },
    choreography: hasMotion
      ? ["Use source-observed motion evidence as the ceiling for preview animation.", "Reveal title, media, and metadata in the same hierarchy as the source."]
      : ["Keep motion subtle and functional because source evidence is weak.", "Use static settled states when animation would be speculative."],
    cssHint: hasMotion ? "Use captured transition/animation evidence before adding new motion." : "No strong source motion captured; use reduced minimal transitions.",
    pptAdapter: hasMotion
      ? ["Apply as a slide-enter reveal for the component role.", "Keep the settled frame source-recognisable."]
      : ["Prefer static source layout; only add focus/entry feedback if needed for clarity."],
    evidence: hasMotion ? ["interactionSignals indicated source motion exists"] : ["no strong motion evidence captured"],
    confidence: hasMotion ? "medium" : "low",
  };
}

function deriveComponentMotionRecipes(evidence: DesignEvidence, tokens: DesignTokens, components: DesignSystemProfile["componentSignatures"]): ComponentMotionRecipe[] {
  const signals = (evidence.behaviorSignals ?? [])
    .filter((signal) => !isNoisyMotionSignal(signal))
    .sort((a, b) => motionSignalPriority(b) - motionSignalPriority(a))
    .slice(0, 5);
  const recipes = signals.map((signal, index) => recipeFromBehaviorSignal(signal, index, tokens, components));
  if (recipes.length === 0) recipes.push(fallbackMotionRecipe(evidence, tokens, components));
  if (recipes.length > 0 && !recipes.some((recipe) => /ppt|slide|reveal/i.test(`${recipe.role} ${recipe.trigger}`))) {
    recipes.push({
      ...fallbackMotionRecipe(evidence, tokens, components),
      id: "ppt-source-reveal-adapter",
      component: "PPT preview choreography",
      role: "presentation transfer",
      trigger: "slide-enter",
      statePair: "off-canvas / transparent -> settled source composition",
      confidence: evidence.interactionSignals.hasAnimations || evidence.interactionSignals.hasTransitions ? "medium" : "low",
    });
  }
  return recipes.slice(0, 6);
}

function inferArchetype(evidence: DesignEvidence) {
  const corpus = evidenceCorpus(evidence);
  if (evidence.sourceMode === "canva-template" || evidence.sourceMode === "canva-editor") {
    return "source-derived presentation template";
  }
  if (evidence.sourceMode === "design-system-project") {
    return "source-derived design system project";
  }
  if (/(ppt|slide|deck|presentation|template)/.test(corpus)) return "source-derived presentation system";
  if (/(component|storybook|dashboard|table|form|nav|tabs|accordion|design system)/.test(corpus)) return "source-derived component system";
  if (/(canvas|webgl|webgpu|audio|shader|three\.js|threejs|interactive)/.test(corpus)) return "source-derived interactive visual system";
  if (evidence.domSignals.formCount > 0 || evidence.domSignals.buttonCount > 8) return "source-derived product workflow";
  if (evidence.assetSummary.images > 0 || evidence.domSignals.imageCount > 4) return "source-derived visual/editorial system";
  return "source-derived web style system";
}

function evidenceConfidence(evidence: DesignEvidence): DesignSystemProfile["confidence"] {
  const signals = [
    evidence.headings.length > 0,
    evidence.colorCandidates.length >= 4,
    evidence.fontCandidates.length > 0,
    (evidence.sections?.length ?? 0) >= 3,
    evidence.assetSummary.total > 0,
    (evidence.roleEvidence?.length ?? 0) >= 3,
    (evidence.behaviorSignals?.length ?? 0) > 0,
  ].filter(Boolean).length;
  if (signals >= 6) return "high";
  if (signals >= 3) return "medium";
  return "low";
}

function presentationStyleGuide(archetype: string, evidence: DesignEvidence): NonNullable<DesignSystemProfile["presentationStyle"]> {
  const sourceLabel = evidence.sourceHost || evidence.title;
  const sourceHasImages = evidence.assetSummary.images > 0 || evidence.domSignals.imageCount > 0;
  const sectionRoles = uniqueStrings((evidence.sections ?? []).map((section) => section.role || section.label), 4);
  const sourceVisual = {
    name: "Source-recognition cover",
    use: "开场页必须先复现来源最可识别的画面关系，再进入抽象规则。",
    construction: [
      "localized source visual or reconstructed source frame",
      "observed title hierarchy",
      "observed background/text/accent relationship",
      "observed navigation or metadata placement",
      "one short source label",
    ],
  };

  return {
    narrativeArc: [
      "Hook: 先展示来源视觉样本或等比例衍生画面，不先展示抽象文案。",
      `Context: 用 ${sourceLabel} 的真实标题、素材、section 顺序和控件语气建立来源上下文。`,
      "Core: 分开说明 observed facts 与 inferred roles，避免把推断写成事实。",
      "Transfer: 用同一套来源规则生成网页与 PPT 衍生预览，再做源图对照。",
      "Audit: 用 preserve / avoid / unknown 三类检查收束，弱证据处必须标注不确定。",
    ],
    themeRhythm: {
      paletteRule: "沿用来源中已经观察到的背景、文字、强调、图片色彩关系；不要引入未被来源证明的新色彩倾向。",
      lightDarkPattern: ["source visual opening", "evidence map", "derived layout specimen", "quality gate close"],
      emphasisCadence: [
        "每个视觉峰值都必须能回指到来源截图、素材、DOM 结构或文案样本。",
        "连续页面的明暗、密度和图片使用应来自来源节奏，而不是套用固定模板。",
        "当来源证据不足时，降低风格断言强度，并优先展示证据而非猜测。",
      ],
    },
    slideArchetypes: [
      sourceVisual,
      ...requiredPresentationSampleArchetypes(),
      {
        name: "Evidence ledger",
        use: "记录哪些设计规则来自直接观察，哪些只是低置信推断。",
        construction: ["source signal", "observed fact", "inferred role", "confidence", "downstream rule"],
      },
      {
        name: "Derived specimen review",
        use: "检查网页与 PPT 衍生样张是否都仍然像来源，而不是变成设计报告或通用模板。",
        construction: ["source role map", "type hierarchy", "color relationship", "layout rhythm", "asset treatment"],
      },
      {
        name: "Component or pattern close-up",
        use: "只抽取来源中实际存在或项目文件明确声明的组件/版式能力。",
        construction: ["pattern name", "observed role", "visual construction", "states if observed", "unknowns"],
      },
      {
        name: "Fidelity checklist close",
        use: "交付前检查是否出现主观改造、模板化、风格漂移或证据缺失。",
        construction: ["source recognition", "role traceability", "layout consistency", "asset fidelity", "anti-patterns"],
      },
    ],
    typographyHierarchy: [
      "Display、body、mono 等角色必须由来源字号层级、文字用途和字体候选共同决定。",
      "字体名包含变量、fallback 或哈希时，只能标为候选；不能直接当作正式字体规范。",
      "长标题断行应保持来源的层级和节奏，不为了填满卡片而改变语气。",
      "Metadata / kicker / caption 的使用位置必须跟来源的栏目、页码、标签或导航行为对应。",
      "如果来源没有足够字体证据，输出应写 unknown / needs review，而不是指定偏好字体。",
    ],
    imageRules: [
      sourceHasImages ? "优先使用本地化的真实来源图片、截图、logo 或模板缩略图作为识别锚点。" : "来源图片证据不足时，用排版关系和真实文案样本承载识别，不虚构图片风格。",
      "图片比例、裁切、留白、圆角、遮罩和叠字方式都必须来自来源观察或明确标记为推断。",
      "网页和 PPT 衍生预览都要先与来源视觉做并排核对，再判断是否可用。",
      "不要把介绍页、平台 UI、浏览器外壳或中介网站元素当成来源设计系统。",
    ],
    motionRecipes: [
      "只在来源发现 transition / animation / scroll / interaction 证据时写具体动效规则。",
      "优先执行 componentMotionRecipes：把 hover/scroll/state/keyframe 证据转成组件微交互和 PPT 入场/强调/状态转译。",
      "未发现动效证据时，使用最小反馈动效，并把 motion 标记为低置信。",
      "动效必须服务于来源中的状态变化、阅读顺序或交互反馈，不作为装饰偏好。",
    ],
    chromeAndMetadata: [
      "跨页 chrome 只来自来源中真实的导航、页码、标签、作者、来源域名或项目路径。",
      "证据页必须区分 source fact、inferred role 和 unknown。",
      `任何外部 agent 调用时都要先读 ${sourceLabel} 的本地化 source evidence，再生成衍生物。`,
    ],
    qualityChecks: [
      "缩略图不看标题时，是否还能看出与来源相同的视觉关系。",
      "每条具体风格规则是否能回指到来源图片、DOM、CSS、项目文件或 README 证据。",
      "是否避免把内容替换成设计系统报告或内部说明文案。",
      "当页面表达流程、进度、供应链、Agent 接力或人工判断时，核心信息是否先用节点/连线/状态徽标/图形模块表达，而不是堆成长段文字。",
      "网页衍生预览与 PPT 衍生预览是否共享同一套抽象规则。",
      `分类 ${archetype} 是否只是来源能力标签，而不是套模板的理由。`,
      sectionRoles.length ? `是否覆盖来源中出现的 section roles: ${sectionRoles.join(", ")}。` : "如果 section evidence 缺失，是否把布局规则标为低置信。",
    ],
  };
}

function nonEmptyArray<T>(value: unknown, fallback: T[]) {
  return Array.isArray(value) && value.length > 0 ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items : fallback;
}

// AI synthesizers occasionally return literal schema field names ("url",
// "tone", "color", "design", etc.) as values when the prompt provides a
// noisy evidence pack. Tone descriptors should be real adjectives — reject
// values that are obviously parroted field names so downstream UIs don't
// surface "tone: [url]".
const TONE_BLOCKLIST = new Set([
  "url",
  "tone",
  "color",
  "colors",
  "design",
  "system",
  "background",
  "text",
  "primary",
  "secondary",
  "voice",
  "brand",
  "n/a",
  "none",
  "unknown",
  "tbd",
]);

function sanitizeToneArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !TONE_BLOCKLIST.has(item.toLowerCase()));
  return items.length ? items : fallback;
}

/**
 * W4: reject font-family slots that look like prose descriptions rather
 * than a CSS font-family identifier.
 *
 * A valid font-family value is one of:
 *   - "Inter", "Documan", "Alpha"
 *   - "SF Pro Display"
 *   - "Inter, sans-serif"
 *   - "var(--font-display)"
 *
 * Description-shaped failures we've actually seen from the AI:
 *   - "custom oversized NOA wordmark, not body font"
 *   - "Sans-serif, possibly Helvetica-derived"
 *   - "a clean grotesk like Inter or similar"
 *
 * The heuristic: a family name (or short CSS font-family stack) should
 * have <= 4 comma-separated parts, each part <= 4 words, no sentence
 * punctuation, no negation words.
 */
const FONT_DESCRIPTION_HINTS = /\b(not|possibly|like|maybe|likely|similar|wordmark|oversized|derived|a|the)\b/i;
function looksLikeFontFamily(value: string): boolean {
  if (!value) return false;
  // W9.1: real font stacks from template @font-face + CSS variables can
  // be long when they chain Latin + CJK + system fallbacks (e.g.
  // `"Inter", "Helvetica Neue", ..., "PingFang SC", "Noto Sans SC", ...`
  // for Swiss; `"Playfair Display", "Source Serif 4", Georgia, serif,
  // "Noto Serif SC", source-han-serif-sc, serif` for Magazine). Bumping
  // length 80→320 and max parts 4→18 to accept these multi-script stacks.
  if (value.length > 320) return false;
  // Sentence-style punctuation rejected (full-stop / exclam / question /
  // semicolons). Colons only rejected when followed by whitespace
  // (sentence colons); `wght@400` style Google Fonts specs use bare `:`.
  if (/[.!?;]/.test(value)) return false;
  if (/:\s/.test(value)) return false;
  if (FONT_DESCRIPTION_HINTS.test(value)) return false;
  // Reject CSS variable references — unresolved tokens, not font names.
  if (/\bvar\s*\(/i.test(value)) return false;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 18) return false;
  return parts.every((part) => part.split(/\s+/).length <= 4);
}

function sanitizeFontFamily(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (!v) return fallback;
  if (v.toLowerCase() === "unknown") return fallback;
  if (!looksLikeFontFamily(v)) return fallback;
  return v;
}

// Accept a string only if it looks like a CSS hex color (3 / 4 / 6 / 8
// chars). Used for the optional surfaceAlternate / surfaceDeep slots
// in colorRoles — keeps the AI from pushing arbitrary descriptive text
// like "soft cream paper" through these slots.
function optionalHex(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

// Inlined copy of ingestion.isNoisyFontCandidate so synthesis can filter
// trial / placeholder fonts BEFORE the AI sees them. Inlined (rather than
// imported) to avoid the synthesis → ingestion → synthesis circular dep.
const SYNTH_FONT_NOISE = /\b(unlicensed|trial|placeholder|fallback|draft)\b/i;
function isNoisyFontName(family: string) {
  return Boolean(family) && SYNTH_FONT_NOISE.test(family);
}

function normalizeAccentPalette(value: unknown): DesignSystemProfile["colorRoles"]["accentPalette"] {
  if (!Array.isArray(value)) return undefined;
  const HEX = /^#[0-9a-f]{3,8}$/i;
  const entries: NonNullable<DesignSystemProfile["colorRoles"]["accentPalette"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const hex = typeof record.hex === "string" ? record.hex.trim() : "";
    if (!HEX.test(hex)) continue;
    const role = typeof record.role === "string" && record.role.trim() ? record.role.trim() : undefined;
    // W4.1: collapse free-form role into one of seven canonical layout
    // roles. Prefer the model's explicit canonicalRole when it gave one,
    // otherwise infer via the synonym table. Unknown → undefined; the
    // compiler decides whether to map that to "decorative" or skip the
    // canonical alias entirely.
    const aiCanonical = typeof record.canonicalRole === "string" ? record.canonicalRole.trim() : "";
    const canonicalRole =
      (aiCanonical ? toCanonicalRole(aiCanonical) : undefined) ?? toCanonicalRole(role);
    entries.push({
      hex,
      role,
      canonicalRole,
      coverage: typeof record.coverage === "string" && record.coverage.trim() ? record.coverage.trim() : undefined,
      evidence: typeof record.evidence === "string" && record.evidence.trim() ? record.evidence.trim() : undefined,
    });
  }
  return entries.length ? entries : undefined;
}

// Inlined hex helpers (synthesis → ingestion → synthesis would be circular, so
// we keep small copies here per the same precedent as optionalHex above).
function synthHexToRgb(hex: string): [number, number, number] | null {
  let v = hex.trim().replace(/^#/, "").toLowerCase();
  if (v.length === 3) v = v.split("").map((c) => c + c).join("");
  if (v.length === 8) v = v.slice(0, 6);
  if (v.length !== 6 || /[^0-9a-f]/.test(v)) return null;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function synthSaturation(hex: string): number {
  const rgb = synthHexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function synthLuminance(hex: string): number {
  const rgb = synthHexToRgb(hex);
  if (!rgb) return 0;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/**
 * Deterministic accent-palette floor. The model path used to be the ONLY
 * source of colorRoles.accentPalette, so legacy/regenerated designs (which run
 * the deterministic fallbackProfile, never the model) shipped an empty palette
 * and dropped every saturated identity color beyond the 4 base slots. This
 * builds a palette from rendered-journey dominant colors → CSS color
 * candidates → token palette, keeps only saturated identity colors (excluding
 * the background/text roles), and maps each to a canonical role so the token
 * stylesheet can emit `--dv-color-role-*` aliases downstream.
 */
function buildDeterministicAccentPalette(
  evidence: DesignEvidence | undefined,
  colorRoles: { background?: string; text?: string },
  tokens?: DesignTokens,
): NonNullable<DesignSystemProfile["colorRoles"]["accentPalette"]> {
  const HEX = /^#[0-9a-f]{3,8}$/i;
  type Candidate = { hex: string; coverage?: number; role?: string; evidence?: string };
  const candidates: Candidate[] = [];
  const push = (value: unknown, extra: Omit<Candidate, "hex">) => {
    if (typeof value !== "string") return;
    const hex = value.trim().toLowerCase();
    if (!HEX.test(hex)) return;
    candidates.push({ hex, ...extra });
  };
  for (const dominant of evidence?.visualCrossCheck?.dominantColors ?? []) {
    push(dominant.value, { coverage: dominant.coverage, role: dominant.roleHint, evidence: "rendered journey dominant field" });
  }
  for (const candidate of evidence?.colorCandidates ?? []) {
    push(candidate.value, { coverage: candidate.coverage, evidence: candidate.source === "rendered" ? "rendered color candidate" : "css color candidate" });
  }
  if (tokens?.colors) {
    for (const [name, value] of Object.entries(tokens.colors)) {
      if (name === "surface" || name === "text" || name === "neutral") continue;
      push(value, { role: name, evidence: "token palette" });
    }
  }
  const background = (colorRoles.background ?? "").trim().toLowerCase();
  const text = (colorRoles.text ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const filtered = candidates
    .filter((candidate) => {
      if (candidate.hex === background || candidate.hex === text) return false;
      if (synthSaturation(candidate.hex) < 0.24) return false;
      const lum = synthLuminance(candidate.hex);
      if (lum < 0.06 || lum > 0.95) return false;
      if (seen.has(candidate.hex)) return false;
      seen.add(candidate.hex);
      return true;
    })
    .sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0));
  return filtered.slice(0, 8).map((candidate, index) => {
    const role = candidate.role?.trim() || (index === 0 ? "hero-fill" : index === 1 ? "panel-accent" : "decorative-marker");
    return {
      hex: candidate.hex,
      role,
      canonicalRole: toCanonicalRole(role),
      coverage: typeof candidate.coverage === "number" ? `${Math.round(candidate.coverage * 100)}% rendered coverage` : undefined,
      evidence: candidate.evidence,
    };
  });
}

/**
 * Merge a preferred palette (model output) with the deterministic floor:
 * preferred entries first, then backfill saturated colors the model missed.
 * Dedupe by hex; cap so the card swatch strip and token stylesheet stay bounded.
 */
function mergeAccentPalettes(
  preferred: DesignSystemProfile["colorRoles"]["accentPalette"],
  floor: DesignSystemProfile["colorRoles"]["accentPalette"],
  cap = 10,
): DesignSystemProfile["colorRoles"]["accentPalette"] {
  const out: NonNullable<DesignSystemProfile["colorRoles"]["accentPalette"]> = [];
  const seen = new Set<string>();
  for (const entry of [...(preferred ?? []), ...(floor ?? [])]) {
    const key = entry.hex.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= cap) break;
  }
  return out.length ? out : undefined;
}

/**
 * Hero-viewport override (v1). The top/load viewport is usually the best hero,
 * but some sites open on a desaturated intro frame (e.g. a black dot-matrix
 * splash) whose design substance only appears further down. When the load
 * viewport carries NO saturated brand color but a later content viewport does,
 * return that content viewport's path so previews lead with substance.
 * Conservative — returns undefined (no override) in every other case, so it
 * never moves a hero that already carries the brand color (e.g. Le Puzz yellow).
 */
function pickHeroViewport(evidence: DesignEvidence | undefined): string | undefined {
  const steps = (evidence?.visualCrossCheck?.steps ?? [])
    .filter((step) => step.action !== "hover" && typeof step.screenshotPath === "string")
    .slice(0, 5);
  if (steps.length < 2) return undefined;
  const saturatedColorCount = (step: (typeof steps)[number]) =>
    step.colorCandidates.filter((candidate) => {
      const s = synthSaturation(candidate.value);
      const l = synthLuminance(candidate.value);
      return s > 0.25 && l > 0.08 && l < 0.95;
    }).length;
  if (saturatedColorCount(steps[0]) >= 1) return undefined;
  for (let i = 1; i < steps.length; i += 1) {
    if (saturatedColorCount(steps[i]) >= 1) return steps[i].screenshotPath;
  }
  return undefined;
}

function uniqueComponentSignatures(items: DesignSystemProfile["componentSignatures"]) {
  const seen = new Set<string>();
  const result: DesignSystemProfile["componentSignatures"] = [];
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.length ? result : items;
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function confidenceValue(value: unknown, fallback: ComponentMotionRecipe["confidence"]): ComponentMotionRecipe["confidence"] {
  return value === "high" || value === "medium" || value === "low" ? value : fallback;
}

function normalizeComponentMotionRecipes(
  value: unknown,
  fallback: ComponentMotionRecipe[],
): ComponentMotionRecipe[] {
  const input = Array.isArray(value) ? value : [];
  const normalized = input.slice(0, 6).map((item, index) => {
    const raw = item as Partial<ComponentMotionRecipe> | undefined;
    const fallbackItem = fallback[index] ?? fallback[0];
    const component = stringValue(raw?.component, fallbackItem.component);
    const role = stringValue(raw?.role, fallbackItem.role);
    return {
      id: slugId(stringValue(raw?.id, `${component}-${role}-${index + 1}`), fallbackItem.id),
      component,
      role,
      trigger: stringValue(raw?.trigger, fallbackItem.trigger),
      statePair: stringValue(raw?.statePair, fallbackItem.statePair),
      properties: stringArray(raw?.properties, fallbackItem.properties).slice(0, 6),
      timing: {
        duration: stringValue(raw?.timing?.duration, fallbackItem.timing.duration),
        easing: stringValue(raw?.timing?.easing, fallbackItem.timing.easing),
        delay: typeof raw?.timing?.delay === "string" && raw.timing.delay.trim() ? raw.timing.delay.trim() : fallbackItem.timing.delay,
        stagger: typeof raw?.timing?.stagger === "string" && raw.timing.stagger.trim() ? raw.timing.stagger.trim() : fallbackItem.timing.stagger,
      },
      choreography: stringArray(raw?.choreography, fallbackItem.choreography).slice(0, 4),
      cssHint: stringValue(raw?.cssHint, fallbackItem.cssHint),
      pptAdapter: stringArray(raw?.pptAdapter, fallbackItem.pptAdapter).slice(0, 4),
      evidence: stringArray(raw?.evidence, fallbackItem.evidence).slice(0, 4),
      confidence: confidenceValue(raw?.confidence, fallbackItem.confidence),
    };
  });
  return normalized.length ? normalized : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringFromRecord(record: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function arrayFromRecord(record: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  return undefined;
}

function summarizeRecord(record: Record<string, unknown> | undefined, keys: string[], limit = 4) {
  if (!record) return undefined;
  const parts: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}: ${value.trim()}`);
    } else if (Array.isArray(value)) {
      const text = value.filter((item) => typeof item === "string" && item.trim()).slice(0, 3).join(", ");
      if (text) parts.push(`${key}: ${text}`);
    }
    if (parts.length >= limit) break;
  }
  return parts.length ? parts.join("; ") : undefined;
}

function adaptModelProfileShape(parsed: DesignSystemProfile): DesignSystemProfile {
  const raw = parsed as DesignSystemProfile & Record<string, unknown>;
  const visualTheme = recordValue(raw.visualTheme);
  const color = recordValue(raw.color);
  const colorRoles = recordValue(color?.roles) ?? color;
  const typography = recordValue(raw.typography);
  const typographyRoles = recordValue(typography?.roles) ?? typography;
  const spacing = recordValue(raw.spacing);
  const layout = recordValue(raw.layout);
  const components = recordValue(raw.components);
  const motion = recordValue(raw.motion);
  const interaction = recordValue(raw.interaction);
  const adapted = { ...raw } as Partial<DesignSystemProfile> & Record<string, unknown>;

  adapted.systemName ??= stringFromRecord(raw, ["systemName", "name", "title"]);
  adapted.archetype ??= stringFromRecord(raw, ["archetype", "classification", "type"]);
  adapted.visualThesis ??= stringFromRecord(raw, ["visualThesis", "thesis"]) ?? stringFromRecord(visualTheme, ["character", "summary", "description"]);
  adapted.summary ??= stringFromRecord(raw, ["summary", "description"]) ?? summarizeRecord(visualTheme, ["character", "density", "surfaceLanguage"], 3);
  if (raw.confidence !== "high" && raw.confidence !== "medium" && raw.confidence !== "low") {
    const confidence = stringFromRecord(visualTheme, ["evidenceConfidence", "confidence"]);
    if (confidence === "high" || confidence === "medium" || confidence === "low") adapted.confidence = confidence;
  }

  adapted.visualDna = {
    ...(recordValue(raw.visualDna) ?? {}),
    colorAtmosphere: stringFromRecord(recordValue(raw.visualDna), ["colorAtmosphere"]) ??
      summarizeRecord(colorRoles, ["brandPrimary", "primary", "accent", "background", "surface", "text", "foreground"]) ??
      stringFromRecord(visualTheme, ["character"]),
    typographySignal: stringFromRecord(recordValue(raw.visualDna), ["typographySignal"]) ??
      summarizeRecord(typographyRoles, ["display", "body", "mono", "hierarchy", "rationale"]),
    layoutGrammar: stringFromRecord(recordValue(raw.visualDna), ["layoutGrammar"]) ??
      summarizeRecord(layout, ["grammar", "rhythm", "density", "composition", "rules"]) ??
      summarizeRecord(visualTheme, ["density", "edgeTreatment", "surfaceLanguage"]),
    componentLanguage: stringFromRecord(recordValue(raw.visualDna), ["componentLanguage"]) ??
      summarizeRecord(components, ["language", "patterns", "rules", "states"]),
    motionCharacter: stringFromRecord(recordValue(raw.visualDna), ["motionCharacter"]) ??
      summarizeRecord(motion, ["character", "rules", "recipes"]) ??
      summarizeRecord(interaction, ["character", "states", "motionNotes"]),
    mustPreserve: arrayFromRecord(recordValue(raw.visualDna), ["mustPreserve"]) ??
      arrayFromRecord(raw, ["mustPreserve", "preserve"]) ??
      arrayFromRecord(visualTheme, ["mustPreserve", "preserve"]),
  } as DesignSystemProfile["visualDna"];

  adapted.colorRoles = {
    ...(recordValue(raw.colorRoles) ?? {}),
    brandPrimary: stringFromRecord(recordValue(raw.colorRoles), ["brandPrimary"]) ?? stringFromRecord(colorRoles, ["brandPrimary", "primary", "accent", "brand", "cta"]),
    brandSecondary: stringFromRecord(recordValue(raw.colorRoles), ["brandSecondary"]) ?? stringFromRecord(colorRoles, ["brandSecondary", "secondary", "muted"]),
    background: stringFromRecord(recordValue(raw.colorRoles), ["background"]) ?? stringFromRecord(colorRoles, ["background", "surface", "bg"]),
    text: stringFromRecord(recordValue(raw.colorRoles), ["text"]) ?? stringFromRecord(colorRoles, ["text", "foreground", "ink"]),
    notes: arrayFromRecord(recordValue(raw.colorRoles), ["notes"]) ?? arrayFromRecord(color, ["notes", "rules"]),
  } as DesignSystemProfile["colorRoles"];

  adapted.typographyRoles = {
    ...(recordValue(raw.typographyRoles) ?? {}),
    display: stringFromRecord(recordValue(raw.typographyRoles), ["display"]) ?? stringFromRecord(typographyRoles, ["display", "headline", "heading"]),
    body: stringFromRecord(recordValue(raw.typographyRoles), ["body"]) ?? stringFromRecord(typographyRoles, ["body", "text", "paragraph"]),
    mono: stringFromRecord(recordValue(raw.typographyRoles), ["mono"]) ?? stringFromRecord(typographyRoles, ["mono", "metadata", "code"]),
    rationale: arrayFromRecord(recordValue(raw.typographyRoles), ["rationale"]) ?? arrayFromRecord(typography, ["rationale", "notes", "rules"]),
  } as DesignSystemProfile["typographyRoles"];

  adapted.spacingSystem = {
    ...(recordValue(raw.spacingSystem) ?? {}),
    base: stringFromRecord(recordValue(raw.spacingSystem), ["base"]) ?? stringFromRecord(spacing, ["base", "scale"]),
    density: stringFromRecord(recordValue(raw.spacingSystem), ["density"]) ?? stringFromRecord(spacing, ["density"]) ?? stringFromRecord(visualTheme, ["density"]),
    rhythmNotes: arrayFromRecord(recordValue(raw.spacingSystem), ["rhythmNotes"]) ?? arrayFromRecord(spacing, ["rhythmNotes", "rules", "notes"]),
  } as DesignSystemProfile["spacingSystem"];

  adapted.compositionSignatures ??= arrayFromRecord(raw, ["compositionSignatures"]) ?? arrayFromRecord(layout, ["signatures", "rules", "composition"]);
  adapted.componentSignatures ??= arrayFromRecord(raw, ["componentSignatures"]) as DesignSystemProfile["componentSignatures"] | undefined;
  adapted.componentMotionRecipes ??= arrayFromRecord(raw, ["componentMotionRecipes"]) as DesignSystemProfile["componentMotionRecipes"] | undefined;
  adapted.antiPatterns ??= arrayFromRecord(raw, ["antiPatterns"]) as string[] | undefined;
  adapted.evidenceSummary ??= arrayFromRecord(raw, ["evidenceSummary"]) as string[] | undefined;
  adapted.presentationStyle ??= (recordValue(raw.presentationStyle) ?? recordValue(raw.presentation)) as DesignSystemProfile["presentationStyle"] | undefined;

  return adapted as DesignSystemProfile;
}

function normalizeModelProfile(parsed: DesignSystemProfile, fallback: DesignSystemProfile, evidence?: DesignEvidence): DesignSystemProfile {
  const adaptedParsed = adaptModelProfileShape(parsed);
  const profile = adaptedParsed as Partial<DesignSystemProfile>;
  const methodology = profile.methodology ?? fallback.methodology!;
  const visualDna = profile.visualDna ?? fallback.visualDna!;
  const previewStrategy = profile.previewStrategy ?? fallback.previewStrategy!;
  const colorRoles = profile.colorRoles ?? fallback.colorRoles;
  const typographyRoles = profile.typographyRoles ?? fallback.typographyRoles;
  const spacingSystem = profile.spacingSystem ?? fallback.spacingSystem;
  const interactionModel = profile.interactionModel ?? fallback.interactionModel;
  const voiceAndBrand = profile.voiceAndBrand ?? fallback.voiceAndBrand;
  const openSlideGuidance = profile.openSlideGuidance ?? fallback.openSlideGuidance;

  const componentSignatures = uniqueComponentSignatures(nonEmptyArray(profile.componentSignatures, fallback.componentSignatures).map((item, index) => {
    const fallbackItem = fallback.componentSignatures[index] ?? fallback.componentSignatures[0];
    return {
      name: nonEmptyString(item?.name, fallbackItem.name),
      role: nonEmptyString(item?.role, fallbackItem.role),
      traits: stringArray(item?.traits, fallbackItem.traits),
      states: stringArray(item?.states, fallbackItem.states),
    };
  }));
  const componentMotionRecipes = normalizeComponentMotionRecipes(profile.componentMotionRecipes, fallback.componentMotionRecipes ?? []);
  const resolvedVisualThesis = nonEmptyString(profile.visualThesis, fallback.visualThesis);
  const modelVisualSeed = resolvedVisualThesis !== fallback.visualThesis ? resolvedVisualThesis : "";
  const fallbackWithModelSeed = (fallbackText: string) => [modelVisualSeed, fallbackText].filter(Boolean).join(" ");

  // v1 motion choreography (additive, flag-gated). Compute once and
  // enumerate it explicitly in the strict-mode return below so it is never
  // an AI-passthrough. When evidence is unavailable, prefer the choreography
  // already derived on the fallback profile (Path 1) rather than
  // synthesizing from a synthetic empty evidence. Flag off → undefined →
  // strict object omits it → byte-identical to pre-feature output.
  const normalizedTokens = normalizeProfileTokens(profile.tokens, profile, fallback, evidence);
  const motionChoreography = motionChoreographyEnabled()
    ? evidence
      ? buildMotionChoreography(evidence, normalizedTokens, { componentSignatures, componentMotionRecipes })
      : fallback.motionChoreography
    : undefined;

  // Strict-mode merge: do NOT spread the raw `adaptedParsed` AI output
  // (which historically leaked hallucinated top-level fields like
  // `layoutCharacter`, `voice`, `name`, etc. through into profile.json).
  // Every legitimate field is explicitly enumerated below; anything the
  // AI emitted outside this schema is intentionally dropped.
  return {
    ...fallback,
    schemaVersion: "2.0",
    systemName: nonEmptyString(profile.systemName, fallback.systemName),
    archetype: nonEmptyString(profile.archetype, fallback.archetype),
    confidence: profile.confidence === "high" || profile.confidence === "medium" || profile.confidence === "low" ? profile.confidence : fallback.confidence,
    visualThesis: resolvedVisualThesis,
    summary: nonEmptyString(profile.summary, fallback.summary),
    methodology: {
      sourceOfTruth: stringArray(methodology.sourceOfTruth, fallback.methodology!.sourceOfTruth),
      abstractionSteps: stringArray(methodology.abstractionSteps, fallback.methodology!.abstractionSteps),
      fidelityChecks: stringArray(methodology.fidelityChecks, fallback.methodology!.fidelityChecks),
    },
    visualDna: {
      colorAtmosphere: nonEmptyString(visualDna.colorAtmosphere, fallbackWithModelSeed(fallback.visualDna!.colorAtmosphere)),
      typographySignal: nonEmptyString(visualDna.typographySignal, fallback.visualDna!.typographySignal),
      layoutGrammar: nonEmptyString(visualDna.layoutGrammar, fallbackWithModelSeed(fallback.visualDna!.layoutGrammar)),
      componentLanguage: nonEmptyString(visualDna.componentLanguage, fallback.visualDna!.componentLanguage),
      motionCharacter: nonEmptyString(visualDna.motionCharacter, fallbackWithModelSeed(fallback.visualDna!.motionCharacter)),
      mustPreserve: uniqueStrings([...stringArray(visualDna.mustPreserve, []), modelVisualSeed, ...fallback.visualDna!.mustPreserve], 8),
    },
    previewStrategy: {
      renderer: previewStrategy.renderer ?? fallback.previewStrategy!.renderer,
      heroAsset: pickHeroViewport(evidence),
      rationale: nonEmptyString(previewStrategy.rationale, fallback.previewStrategy!.rationale),
      layoutDirectives: stringArray(previewStrategy.layoutDirectives, fallback.previewStrategy!.layoutDirectives),
      avoidDirectives: stringArray(previewStrategy.avoidDirectives, fallback.previewStrategy!.avoidDirectives),
    },
    colorRoles: {
      brandPrimary: nonEmptyString(colorRoles.brandPrimary, fallback.colorRoles.brandPrimary),
      brandSecondary: nonEmptyString(colorRoles.brandSecondary, fallback.colorRoles.brandSecondary),
      background: nonEmptyString(colorRoles.background, fallback.colorRoles.background),
      text: nonEmptyString(colorRoles.text, fallback.colorRoles.text),
      notes: stringArray(colorRoles.notes, fallback.colorRoles.notes),
      // Optional editorial surfaces — only kept when the AI / hand-edit
      // actually provides a hex; strict-mode merge would otherwise drop
      // them as unknown fields.
      surfaceAlternate: optionalHex(colorRoles.surfaceAlternate, fallback.colorRoles.surfaceAlternate),
      surfaceDeep: optionalHex(colorRoles.surfaceDeep, fallback.colorRoles.surfaceDeep),
      accentPalette: mergeAccentPalettes(
        normalizeAccentPalette(colorRoles.accentPalette),
        buildDeterministicAccentPalette(evidence, { background: colorRoles.background, text: colorRoles.text }, undefined),
      ),
    },
    typographyRoles: {
      // W4 sanitize: reject prose descriptions like "custom oversized NOA
      // wordmark, not body font" — see sanitizeFontFamily for the
      // heuristic. Description-shaped values fall back to the previously
      // accepted role value (body or fallback's default) so downstream
      // CSS gets a valid font-family stack, not a description sentence.
      display: sanitizeFontFamily(typographyRoles.display, fallback.typographyRoles.display),
      body: sanitizeFontFamily(typographyRoles.body, fallback.typographyRoles.body),
      mono: sanitizeFontFamily(typographyRoles.mono, fallback.typographyRoles.mono),
      rationale: stringArray(typographyRoles.rationale, fallback.typographyRoles.rationale),
    },
    spacingSystem: {
      base: nonEmptyString(spacingSystem.base, fallback.spacingSystem.base),
      density: nonEmptyString(spacingSystem.density, fallback.spacingSystem.density),
      rhythmNotes: stringArray(spacingSystem.rhythmNotes, fallback.spacingSystem.rhythmNotes),
    },
    compositionSignatures: stringArray(profile.compositionSignatures, fallback.compositionSignatures),
    componentSignatures,
    componentMotionRecipes,
    interactionModel: {
      character: nonEmptyString(interactionModel.character, fallback.interactionModel.character),
      states: stringArray(interactionModel.states, fallback.interactionModel.states),
      motionNotes: stringArray(interactionModel.motionNotes, fallback.interactionModel.motionNotes),
    },
    voiceAndBrand: {
      tone: sanitizeToneArray(voiceAndBrand.tone, fallback.voiceAndBrand.tone),
      copyNotes: stringArray(voiceAndBrand.copyNotes, fallback.voiceAndBrand.copyNotes),
    },
    accessibilityAndRisks: stringArray(profile.accessibilityAndRisks, fallback.accessibilityAndRisks),
    antiPatterns: stringArray(profile.antiPatterns, fallback.antiPatterns),
    evidenceSummary: uniqueStrings([...stringArray(profile.evidenceSummary, []), ...fallback.evidenceSummary], 10),
    openSlideGuidance: {
      direction: nonEmptyString(openSlideGuidance.direction, fallback.openSlideGuidance.direction),
      coverApproach: nonEmptyString(openSlideGuidance.coverApproach, fallback.openSlideGuidance.coverApproach),
      layoutApproach: stringArray(openSlideGuidance.layoutApproach, fallback.openSlideGuidance.layoutApproach),
      motionApproach: stringArray(openSlideGuidance.motionApproach, fallback.openSlideGuidance.motionApproach),
    },
    presentationStyle: normalizePresentationStyle(profile.presentationStyle, fallback.presentationStyle!),
    tokens: normalizedTokens,
    motionChoreography,
  };
}

/**
 * Deterministic profile normalizer for non-AI pipelines (e.g. project /
 * skill-package imports). Applies the same sanitizers as the AI-synthesis
 * path: font family validation, surface-constraint enforcement, and
 * tier-2 token generation, without requiring a model call. A safe
 * fallback replaces only typography defaults (to catch unresolved CSS
 * variables like `var(--mono)`); all other fields stay from the profile.
 */
export function normalizeProfileForEmission(
  profile: DesignSystemProfile,
  evidence?: DesignEvidence,
): DesignSystemProfile {
  const safeFallback: DesignSystemProfile = {
    ...profile,
    typographyRoles: {
      display: "Inter",
      body: "Inter",
      mono: "JetBrains Mono",
      rationale: profile.typographyRoles.rationale,
    },
  };
  return normalizeModelProfile(profile, safeFallback, evidence);
}

/**
 * Build a tier-2 token bundle from an old-schema profile (one that still
 * uses the flat `colorRoles + typographyRoles + spacingSystem` triple).
 * Pure derivation — does NOT call the model. This lets every existing
 * profile in the library light up the new renderer without a costly
 * re-import.
 *
 * The naming of primitive keys is deliberate: short, semantic-enough to be
 * inspectable in CSS (`--dv-color-brand`, not `--dv-color-1`), but kept
 * separate from the semantic layer so the same primitive can be referenced
 * by multiple semantic roles. The semantic layer points to these keys.
 */
/**
 * Reconcile AI-emitted `tokens` with the deterministic migrator output.
 *
 * The AI's job is mainly the semantic layer (role labels pointing at
 * primitive keys). Even when it complies, it might emit garbage
 * primitive maps that overshadow the evidence-extracted values. We
 * compute the deterministic base from migrator (which prefers
 * evidence), then overlay only the SEMANTIC keys the AI cared to set.
 * Primitive maps stay deterministic.
 */
export function normalizeProfileTokens(
  aiTokens: DesignSystemProfile["tokens"] | undefined,
  profile: Partial<DesignSystemProfile>,
  fallback: DesignSystemProfile,
  evidence?: DesignEvidence,
): DesignSystemProfile["tokens"] {
  const base = migrateLegacyProfileTokens(profile, fallback, evidence);
  if (!base) return base;
  if (!aiTokens) {
    // No AI overlay — still need the W4.3 guard to catch cases where
    // the migrator's deterministic mapping itself collapsed alt/deep
    // onto the accent or background (happens when colorRoles set
    // surfaceAlternate = brandPrimary, which the AI tends to do).
    enforceDistinctSurfaceConstraints(base, profile);
    return base;
  }
  // Merge AI's optional extra primitives into the deterministic base
  // (only adds new color keys — never overrides evidence-derived ones).
  if (aiTokens.primitive?.color) {
    for (const [k, v] of Object.entries(aiTokens.primitive.color)) {
      if (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v) && !base.primitive.color[k]) {
        base.primitive.color[k] = v;
      }
    }
  }
  // Overlay any semantic-key the AI provided, validating that the
  // referenced primitive key actually exists. If it doesn't, keep the
  // migrator's choice.
  const sem = aiTokens.semantic;
  if (sem && base.semantic) {
    const checkColor = (k?: string) => (k && base.primitive.color[k] ? k : undefined);
    const checkRadius = (k?: string) => (k && base.primitive.radius[k] ? k : undefined);
    const checkDuration = (k?: string) => (k && base.primitive.duration[k] !== undefined ? k : undefined);
    if (sem.bg) {
      base.semantic.bg = {
        default: checkColor(sem.bg.default) ?? base.semantic.bg.default,
        alt: checkColor(sem.bg.alt) ?? base.semantic.bg.alt,
        deep: checkColor(sem.bg.deep) ?? base.semantic.bg.deep,
      };
    }
    if (sem.text) {
      base.semantic.text = {
        primary: checkColor(sem.text.primary) ?? base.semantic.text.primary,
        muted: checkColor(sem.text.muted) ?? base.semantic.text.muted,
        inverse: checkColor(sem.text.inverse) ?? base.semantic.text.inverse,
      };
    }
    if (sem.accent) {
      base.semantic.accent = {
        primary: checkColor(sem.accent.primary) ?? base.semantic.accent.primary,
        secondary: checkColor(sem.accent.secondary) ?? base.semantic.accent.secondary,
        success: checkColor(sem.accent.success) ?? base.semantic.accent.success,
        warning: checkColor(sem.accent.warning) ?? base.semantic.accent.warning,
        danger: checkColor(sem.accent.danger) ?? base.semantic.accent.danger,
      };
    }
    if (sem.radius) {
      base.semantic.radius = {
        button: checkRadius(sem.radius.button) ?? base.semantic.radius.button,
        card: checkRadius(sem.radius.card) ?? base.semantic.radius.card,
        modal: checkRadius(sem.radius.modal) ?? base.semantic.radius.modal,
        avatar: checkRadius(sem.radius.avatar) ?? base.semantic.radius.avatar,
      };
    }
    if (sem.motion) {
      base.semantic.motion = {
        tap: checkDuration(sem.motion.tap) ?? base.semantic.motion.tap,
        reveal: checkDuration(sem.motion.reveal) ?? base.semantic.motion.reveal,
        emphasized: checkDuration(sem.motion.emphasized) ?? base.semantic.motion.emphasized,
      };
    }
    // W4.2: do NOT let the AI override the migrator's posture. Posture
    // is derived deterministically from evidence.durationCandidates; the
    // AI tends to apply taste here ("a slow editorial site feels
    // restrained") and overwrite the literal evidence-grounded reading
    // ("base = 2000ms is dramatic"). Keep the migrator's choice.
  }
  // W4.3: enforce "alt-surface is a distinct identity from accent.primary
  // and from bg.default". If the AI's overlay collapsed bg.alt onto the
  // same hex as accent or bg, find a replacement candidate from the
  // accentPalette or surface slots. The renderer needs at least two
  // distinguishable surface tones to convey "section break"; collapsing
  // them defeats the whole point of having an alt surface.
  enforceDistinctSurfaceConstraints(base, profile);
  return base;
}

/**
 * Resolve a semantic color key to its actual hex via the primitive map.
 * Returns undefined if the key isn't bound or the value isn't a hex.
 */
function resolveSemanticHex(
  key: string | undefined,
  primitive: { color: Record<string, string> },
): string | undefined {
  if (!key) return undefined;
  const value = primitive.color[key];
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value.toLowerCase() : undefined;
}

/**
 * W4.3 guard: prevent semantic surface tokens from collapsing onto the
 * same hex as the accent or background. When the AI maps `bg.alt = brand`
 * (the noa v12 bug), or sets `bg.deep = bg.default`, the renderer ends
 * up with only one visible surface — losing the entire two-surface
 * relationship the AI also claims to recognise in visualThesis.
 *
 * Strategy when a collapse is detected:
 *   1. Walk colorRoles.accentPalette in order, finding the first hex
 *      that is NEITHER the background NOR the accent. That becomes
 *      the alt surface key. Prefer entries whose canonicalRole is
 *      "alt-section" or "hero" (in that priority order).
 *   2. If nothing in accentPalette qualifies, fall back to
 *      colorRoles.surfaceAlternate (if it's distinct).
 *   3. If still nothing, drop bg.alt to undefined — better honest empty
 *      than silently equal-to-accent.
 *
 * The same routine applies to bg.deep (must differ from default).
 */
function enforceDistinctSurfaceConstraints(
  base: NonNullable<DesignSystemProfile["tokens"]>,
  profile: Partial<DesignSystemProfile>,
): void {
  if (!base.semantic) return;
  const primitive = base.primitive;
  const bgHex = resolveSemanticHex(base.semantic.bg.default, primitive);
  const accentHex = resolveSemanticHex(base.semantic.accent.primary, primitive);
  const altHex = resolveSemanticHex(base.semantic.bg.alt, primitive);
  const deepHex = resolveSemanticHex(base.semantic.bg.deep, primitive);

  const findReplacementKey = (forbidden: Set<string>, preferCanonical: string[]): string | undefined => {
    const palette = profile.colorRoles?.accentPalette ?? [];
    // Pass 1: a palette entry whose canonical role matches a preferred slot
    for (const wanted of preferCanonical) {
      for (const entry of palette) {
        const canonical = entry.canonicalRole;
        if (canonical !== wanted) continue;
        const hex = entry.hex?.toLowerCase();
        if (!hex || forbidden.has(hex)) continue;
        // Locate the matching key in primitive.color (legacy slug OR canonical alias)
        for (const [k, v] of Object.entries(primitive.color)) {
          if (v.toLowerCase() === hex) return k;
        }
      }
    }
    // Pass 2: any palette entry whose hex isn't forbidden
    for (const entry of palette) {
      const hex = entry.hex?.toLowerCase();
      if (!hex || forbidden.has(hex)) continue;
      for (const [k, v] of Object.entries(primitive.color)) {
        if (v.toLowerCase() === hex) return k;
      }
    }
    return undefined;
  };

  // alt-surface guard: alt must differ from bg.default AND from accent.primary
  if (altHex && bgHex && accentHex && (altHex === bgHex || altHex === accentHex)) {
    const replacement = findReplacementKey(new Set([bgHex, accentHex]), ["alt-section", "hero"]);
    if (replacement) {
      base.semantic.bg.alt = replacement;
    } else {
      base.semantic.bg.alt = undefined;
    }
  }
  // deep-surface guard: deep must differ from bg.default, from accent.primary,
  // AND from the (possibly repaired) alt. Footer/CTA closing band needs its
  // own visual identity to function as a closing band.
  const newAltHex = resolveSemanticHex(base.semantic.bg.alt, primitive);
  if (
    deepHex && bgHex &&
    (deepHex === bgHex || deepHex === accentHex || deepHex === newAltHex)
  ) {
    const forbidden = new Set([bgHex]);
    if (accentHex) forbidden.add(accentHex);
    if (newAltHex) forbidden.add(newAltHex);
    const replacement = findReplacementKey(forbidden, ["deep-section"]);
    if (replacement) {
      base.semantic.bg.deep = replacement;
    } else {
      base.semantic.bg.deep = undefined;
    }
  }
}

export function migrateLegacyProfileTokens(
  profile: Partial<DesignSystemProfile>,
  fallback: DesignSystemProfile,
  evidence?: DesignEvidence,
): DesignSystemProfile["tokens"] {
  const cr = (profile.colorRoles ?? fallback.colorRoles) as DesignSystemProfile["colorRoles"];
  const tr = (profile.typographyRoles ?? fallback.typographyRoles) as DesignSystemProfile["typographyRoles"];

  // Primitive colors: brand / secondary / bg / text / surface-alt / surface-deep
  // get explicit keys; accentPalette entries fold in by index so the
  // renderer can still address them individually.
  const color: Record<string, string> = {};
  if (cr.brandPrimary) color["brand"] = cr.brandPrimary;
  if (cr.brandSecondary) color["brand-secondary"] = cr.brandSecondary;
  if (cr.background) color["bg"] = cr.background;
  if (cr.text) color["text"] = cr.text;
  if (cr.surfaceAlternate) color["surface-alt"] = cr.surfaceAlternate;
  if (cr.surfaceDeep) color["surface-deep"] = cr.surfaceDeep;
  const canonicalSeen = new Set<string>();
  const palette = cr.accentPalette;
  if (palette) {
    // W4.1: emit BOTH the free-form slug (`hero-fill`) AND a canonical
    // alias (`role-hero`) for every palette entry. Existing previews
    // that hardcoded `--dv-color-hero-fill` still resolve; new previews
    // generated under v13 can pick up cross-site `--dv-color-role-hero`
    // names instead. If two palette entries collapse to the same
    // canonical role (rare — e.g. a site with TWO hero variants), the
    // higher-coverage one wins (palette is ordered by AI's coverage
    // priority).
    for (let i = 0; i < palette.length; i++) {
      const entry = palette[i];
      if (!entry?.hex) continue;
      const slug = slugForPrimitive(entry.role, `accent-${i + 1}`);
      color[slug] = entry.hex;
      const canonical = entry.canonicalRole;
      if (canonical && !canonicalSeen.has(canonical)) {
        color[`role-${canonical}`] = entry.hex;
        canonicalSeen.add(canonical);
      }
    }
  }
  if (cr.surfaceAlternate && !canonicalSeen.has("alt-section")) {
    color["role-alt-section"] = cr.surfaceAlternate;
    canonicalSeen.add("alt-section");
  }
  if (cr.surfaceDeep && !canonicalSeen.has("deep-section")) {
    color["role-deep-section"] = cr.surfaceDeep;
    canonicalSeen.add("deep-section");
  }

  // Spacing: 4-px-grid fallback. Most sites we ingest follow some 4-or-8px
  // grid; a real extractor for spacing tokens is future work.
  const space: Record<string, string> = {
    "0": "0px", "1": "4px", "2": "8px", "3": "12px",
    "4": "16px", "6": "24px", "8": "32px", "12": "48px", "16": "64px",
  };

  // Radius: prefer ingestion-observed values. We bucket the top N radii
  // from extractRadiusCandidates() into named keys so the renderer always
  // has a small canonical set. Anything > 200px becomes `full` (pill).
  //
  // W4.2: handle the single-observed-value case explicitly. A site that
  // only uses one radius (often 0 for editorial flat designs, or 9999 for
  // fully-rounded systems) shouldn't get a graduated 2-4-8-12-16 ladder
  // grafted onto it — the renderer must preserve the source's actual
  // visual rhythm.
  const radius: Record<string, string> = {
    xs: "2px", sm: "4px", md: "8px", lg: "12px", xl: "16px", full: "9999px",
  };
  const observedRadii = evidence?.radiusCandidates ?? [];
  if (observedRadii.length >= 1) {
    const top = observedRadii.slice(0, 5).map((r) => r.px).sort((a, b) => a - b);
    if (top.length === 1 && top[0] === 0) {
      // Editorial flat — every corner is square. Collapse the entire
      // xs..xl scale so any `.dv-rounded-*` consumer renders square.
      radius.xs = "0px"; radius.sm = "0px"; radius.md = "0px";
      radius.lg = "0px"; radius.xl = "0px";
    } else if (top.length === 1) {
      // Single rounded value: that's the design's only radius. Build a
      // proportional ladder around it so consumers can still pick "smaller"
      // or "bigger" variants without drifting away from the brand voice.
      const r = top[0];
      radius.xs = `${Math.max(0, Math.round(r * 0.25))}px`;
      radius.sm = `${Math.max(0, Math.round(r * 0.5))}px`;
      radius.md = `${r}px`;
      radius.lg = `${Math.round(r * 1.5)}px`;
      radius.xl = `${Math.round(r * 2)}px`;
    } else {
      const buckets = ["xs", "sm", "md", "lg", "xl"];
      for (let i = 0; i < top.length && i < buckets.length; i++) {
        radius[buckets[i]] = `${top[i]}px`;
      }
    }
    // `full` stays at 9999px regardless of observation; pills are pills.
  }

  // Font sizes: when ingestion saw a recognisable musical-interval ratio,
  // build the scale from the observed base * ratio^n ladder. Otherwise
  // fall back to a Major-Third (1.25) ladder anchored on 16px.
  const fontSize: Record<string, string> = {};
  const ratioInfo = evidence?.fontSizeRatio;
  if (ratioInfo && ratioInfo.sizesPx.length >= 3) {
    // Use the observed sizes directly when there are enough; sort and
    // map to canonical labels.
    const sorted = [...ratioInfo.sizesPx].sort((a, b) => a - b);
    const labels = ["xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl"];
    for (let i = 0; i < sorted.length && i < labels.length; i++) {
      fontSize[labels[i]] = `${sorted[i]}px`;
    }
  } else {
    const ladder = [12, 14, 16, 18, 22, 28, 36, 48];
    const labels = ["xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl"];
    for (let i = 0; i < ladder.length; i++) fontSize[labels[i]] = `${ladder[i]}px`;
  }

  // Motion: prefer ingestion-observed durations. Cluster heads into
  // fast/base/slow/emphasized buckets by their relative position in the
  // sorted distribution.
  //
  // W4.2: handle the single-observed-value case so sites with one
  // dominant tempo (noa = 2000ms x8) actually USE that tempo in the
  // primitive scale. Previously the `length >= 2` gate fell through to
  // a generic Material-3 ladder, erasing the source's motion character.
  const duration: Record<string, number> = {
    fast: 150, base: 220, slow: 320, emphasized: 500,
  };
  const observedDurations = evidence?.durationCandidates ?? [];
  if (observedDurations.length >= 1) {
    const sorted = [...observedDurations.map((d) => d.ms)].sort((a, b) => a - b);
    if (sorted.length === 1) {
      // Single dominant tempo: scale fast/slow/emphasized proportionally
      // around it so a 2000ms editorial site stays 2000ms-paced and a
      // 100ms snappy dashboard stays snappy.
      const base = sorted[0];
      duration.base = base;
      duration.fast = Math.max(50, Math.round(base * 0.4));
      duration.slow = Math.round(base * 1.5);
      duration.emphasized = Math.round(base * 1.2);
    } else {
      duration.fast = sorted[0] ?? duration.fast;
      duration.base = sorted[Math.floor(sorted.length / 2)] ?? duration.base;
      duration.slow = sorted[sorted.length - 1] ?? duration.slow;
      // Emphasized matches the observed max when it's clearly above
      // base — otherwise keep the canonical 500ms hint.
      if (sorted[sorted.length - 1] > 350) duration.emphasized = sorted[sorted.length - 1];
    }
  }

  // Easing: prefer the most-common observed curve as `standard`; keep
  // canonical Material curves for accelerate/decelerate/emphasized when
  // the source doesn't enumerate them.
  const easing: Record<string, string> = {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    accelerate: "cubic-bezier(0.3, 0, 1, 1)",
    decelerate: "cubic-bezier(0, 0, 0.2, 1)",
    emphasized: "cubic-bezier(0.05, 0.7, 0.1, 1)",
  };
  const observedEasings = evidence?.easingCandidates ?? [];
  if (observedEasings.length) {
    easing.standard = observedEasings[0].curve;
  }

  // Semantic layer: pure label-mapping into the primitive keys above.
  return {
    primitive: { color, space, radius, fontSize, duration, easing },
    semantic: {
      bg: {
        default: color["bg"] ? "bg" : "brand",
        alt: color["surface-alt"] ? "surface-alt" : undefined,
        deep: color["surface-deep"] ? "surface-deep" : undefined,
      },
      text: {
        primary: color["text"] ? "text" : "brand",
        muted: color["brand-secondary"] ? "brand-secondary" : undefined,
      },
      accent: {
        primary: color["brand"] ? "brand" : Object.keys(color)[0] ?? "brand",
        secondary: color["brand-secondary"],
      },
      radius: {
        button: "sm",
        card: "lg",
        modal: "xl",
        avatar: "full",
      },
      motion: {
        tap: "fast",
        reveal: "base",
        emphasized: "emphasized",
      },
      // Posture inference from observed duration distribution:
      //   * median ≤ 200ms with no observation > 350ms → restrained
      //     (Ant Design / enterprise — short, no-nonsense feedback)
      //   * median 200-300ms with some > 400ms → expressive
      //     (most modern marketing sites)
      //   * median > 300ms or many observations in 400-600ms range →
      //     dramatic (Material 3 Emphasized / cinematic landing pages)
      posture: (() => {
        const ms = (evidence?.durationCandidates ?? []).map((d) => d.ms);
        if (ms.length < 1) return undefined;
        const sorted = [...ms].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const max = sorted[sorted.length - 1];
        // W4.2: single-value evidence is still posture-meaningful — a
        // one-shot 2000ms transition tells you the site is dramatic just
        // as clearly as a multi-point distribution would.
        if (median <= 200 && max <= 350) return "restrained" as const;
        if (median > 300 || max >= 500) return "dramatic" as const;
        return "expressive" as const;
      })(),
    },
  };
}

function normalizePresentationStyle(
  value: DesignSystemProfile["presentationStyle"] | undefined,
  fallback: NonNullable<DesignSystemProfile["presentationStyle"]>,
): NonNullable<DesignSystemProfile["presentationStyle"]> {
  const slideArchetypes = withRequiredPresentationSampleArchetypes(nonEmptyArray(value?.slideArchetypes, fallback.slideArchetypes).map((item, index) => {
    const fallbackItem = fallback.slideArchetypes[index] ?? fallback.slideArchetypes[0];
    return {
      name: nonEmptyString(item?.name, fallbackItem.name),
      use: nonEmptyString(item?.use, fallbackItem.use),
      construction: stringArray(item?.construction, fallbackItem.construction),
    };
  }));
  return {
    narrativeArc: stringArray(value?.narrativeArc, fallback.narrativeArc),
    themeRhythm: {
      paletteRule: nonEmptyString(value?.themeRhythm?.paletteRule, fallback.themeRhythm.paletteRule),
      lightDarkPattern: stringArray(value?.themeRhythm?.lightDarkPattern, fallback.themeRhythm.lightDarkPattern),
      emphasisCadence: stringArray(value?.themeRhythm?.emphasisCadence, fallback.themeRhythm.emphasisCadence),
    },
    slideArchetypes,
    typographyHierarchy: stringArray(value?.typographyHierarchy, fallback.typographyHierarchy),
    imageRules: stringArray(value?.imageRules, fallback.imageRules),
    motionRecipes: stringArray(value?.motionRecipes, fallback.motionRecipes),
    chromeAndMetadata: stringArray(value?.chromeAndMetadata, fallback.chromeAndMetadata),
    qualityChecks: stringArray(value?.qualityChecks, fallback.qualityChecks),
  };
}

function fallbackProfile(evidence: DesignEvidence, tokens: DesignTokens): DesignSystemProfile {
  const archetype = inferArchetype(evidence);
  const sourceLabel = evidence.sourceHost || evidence.title;
  const confidence = evidenceConfidence(evidence);
  const roleValue = (role: string, fallback: string) => evidence.roleEvidence?.find((item) => item.role === role)?.value ?? fallback;
  const usableFont = (...values: string[]) =>
    values.find((item) => item && !/^(inherit|initial|unset)$/i.test(item) && !/var\(/i.test(item)) ?? "system-ui, sans-serif";
  const display = usableFont(roleValue("display-font", ""), tokens.typography.families.display, tokens.typography.families.primary);
  const body = usableFont(roleValue("body-font", ""), tokens.typography.families.primary, tokens.typography.families.display);
  const mono = usableFont(roleValue("mono-font", ""), tokens.typography.families.mono, body);
  const colorRoles = {
    brandPrimary: roleValue("accent", tokens.colors.primary),
    brandSecondary: roleValue("secondary", tokens.colors.secondary),
    background: roleValue("background", tokens.colors.surface),
    text: roleValue("text", tokens.colors.text),
  };
  const renderedColors = (evidence.visualCrossCheck?.dominantColors ?? [])
    .slice(0, 4)
    .map((color) => `${color.value}${color.roleHint ? ` (${color.roleHint})` : ""}`);
  const renderedSummary = uniqueStrings(evidence.visualCrossCheck?.representativeSummary ?? [], 3);
  const mediaArtifacts = evidence.visualCrossCheck?.mediaArtifacts ?? [];
  const mediaEvidenceNote = mediaArtifacts.length
    ? `Media-first evidence captured ${mediaArtifacts.filter((artifact) => artifact.kind === "image").length} keyframe image(s) and ${mediaArtifacts.filter((artifact) => artifact.kind === "video").length} motion video(s); downstream generators must inspect them for crop, perspective, depth, masking, scroll choreography, and image scale before relying on DOM/CSS tokens.`
    : "";
  const sectionRoles = uniqueStrings((evidence.sections ?? []).flatMap((section) => [section.role, section.label, ...section.componentHints]), 8);
  const assetSignals = uniqueStrings([
    evidence.assetSummary.images > 0 ? `${evidence.assetSummary.images} localized/source image signals` : undefined,
    evidence.assetSummary.logos > 0 ? `${evidence.assetSummary.logos} logo signals` : undefined,
    evidence.assetSummary.icons > 0 ? `${evidence.assetSummary.icons} icon signals` : undefined,
    evidence.assetSummary.svgs > 0 ? `${evidence.assetSummary.svgs} svg signals` : undefined,
  ]);
  const headingSample = uniqueStrings(evidence.headings, 3).join(" / ") || evidence.title;
  const buttonSample = uniqueStrings(evidence.buttonLabels, 4).join(" / ") || "No explicit button labels captured";
  const hasVisualAssets = evidence.assetSummary.total > 0 || evidence.domSignals.imageCount > 0;
  const density =
    evidence.domSignals.cardLikeCount > 8 || evidence.domSignals.buttonCount > 10
      ? "high-density source structure"
      : (evidence.sections?.length ?? 0) >= 6
        ? "section-led source rhythm"
        : "low-to-medium source density";

  const componentSignatures = [
    {
      name: "Action controls",
      role: "Source-derived calls to action and interactive controls.",
      traits: [
        `Observed labels: ${buttonSample}.`,
        "Preserve the source-observed size, contrast, position, shape, and copy hierarchy; mark missing traits as unknown instead of inventing them.",
      ],
      states: ["default", "hover if observed", "focus-visible", "disabled if applicable"],
    },
    {
      name: "Navigation and metadata",
      role: "Wayfinding, source identity, section labels, page chrome, or project metadata.",
      traits: [
        evidence.domSignals.navCount > 0 ? `${evidence.domSignals.navCount} navigation signal(s) were detected.` : "Navigation was not strongly detected; do not invent a nav-heavy system.",
        "Use only source-observed labels, ordering, and metadata positions when generating derivative previews.",
      ],
      states: ["default", "current if observed", "hover/focus if observed"],
    },
    {
      name: "Content and media sections",
      role: "Primary layout blocks, source assets, text hierarchy, and repeated content structures.",
      traits: [
        sectionRoles.length ? `Observed section/pattern hints: ${sectionRoles.join(", ")}.` : "Section roles are limited; keep layout claims low-confidence.",
        hasVisualAssets ? `Asset evidence: ${assetSignals.join(", ") || "localized/source media present"}.` : "No strong asset evidence; use typography and source text rather than invented imagery.",
      ],
      states: ["default", "responsive if observed"],
    },
  ];
  const presentationStyle = presentationStyleGuide(archetype, evidence);
  const componentMotionRecipes = deriveComponentMotionRecipes(evidence, tokens, componentSignatures);

  const base: DesignSystemProfile = {
    schemaVersion: "2.0",
    systemName: evidence.title,
    archetype,
    confidence,
    visualThesis: `A source-grounded design system for ${sourceLabel}: preserve observed color relationships, typography hierarchy, layout rhythm, asset treatment, and component behavior before generating any derivative preview.`,
    summary: evidence.description || `${evidence.title} 的页面视觉已经被抽取为可复用设计系统。`,
    methodology: {
      sourceOfTruth: [
        "Localized source images, screenshots, README/demo assets, or source page thumbnails when available.",
        "Rendered scroll and hover viewport checks that show how the page actually changes through the viewing journey.",
        "Real heading, link, button, metadata, and section text captured from the source.",
        "CSS color/font candidates, role evidence, DOM topology, behavior signals, and responsive hints.",
        "Generated derivatives must be reviewed against the source visual before being accepted.",
      ],
      abstractionSteps: [
        "Collect and localize source evidence before writing style rules.",
        "Sample the rendered journey: first viewport, scrolled viewports, and safe hover states before deciding representative visual traits.",
        "Separate observed facts from inferred roles; never promote an inference to fact without evidence.",
        "Map color, type, layout, assets, components, and motion into reusable rules using source traceability.",
        "Generate web and PPT derivative previews from those rules, then compare them with the source visual.",
        "Mark low-confidence gaps as unknown instead of filling them with subjective taste.",
      ],
      fidelityChecks: [
        "The derivative preview should still feel source-recognisable without reading its title.",
        "The preview must reflect representative scroll/interaction states, not only the static first frame.",
        "Concrete style claims must trace to source images, DOM/CSS evidence, project files, or README/demo assets.",
        "The preview must not turn into a prose report, generic SaaS card, or unrelated template.",
        "Weak evidence should reduce confidence instead of introducing invented fonts, palettes, layouts, or content.",
      ],
    },
    visualDna: {
      colorAtmosphere: `Observed role candidates: background ${colorRoles.background}, text ${colorRoles.text}, accent ${colorRoles.brandPrimary}, secondary ${colorRoles.brandSecondary}.${renderedColors.length ? ` Rendered journey fields: ${renderedColors.join(", ")}.` : ""} Treat them as source evidence until visually reviewed.`,
      typographySignal: `Observed font candidates map to display ${display}, body ${body}, and mono/metadata ${mono}; unresolved CSS variables remain review items.`,
      layoutGrammar: sectionRoles.length
        ? `Layout grammar is derived from observed media plus sections/patterns: ${sectionRoles.join(", ")}.${mediaEvidenceNote ? ` ${mediaEvidenceNote}` : ""}`
        : "Layout grammar is under-specified; use the localized source visual and DOM density before asserting a reusable layout.",
      componentLanguage: "Component rules must map to observed navigation, action controls, content/media sections, forms, states, and project capabilities.",
      motionCharacter: evidence.interactionSignals.hasAnimations || evidence.interactionSignals.hasTransitions
        ? `Motion evidence exists; distinguish observed interaction feedback from decorative assumptions.${mediaEvidenceNote ? ` ${mediaEvidenceNote}` : ""}`
        : mediaEvidenceNote || "No strong motion evidence was captured; keep motion claims minimal and low-confidence.",
      mustPreserve: uniqueStrings([
        "Source-recognisable first impression",
        mediaEvidenceNote,
        ...renderedSummary,
        "Observed background/text/accent relationship",
        "Observed typography hierarchy",
        "Observed layout density and section rhythm",
        hasVisualAssets ? "Localized source visual assets or screenshots" : undefined,
        evidence.domSignals.navCount > 0 ? "Observed navigation/metadata behavior" : undefined,
        evidence.domSignals.buttonCount > 0 ? "Observed action-control hierarchy" : undefined,
      ], 8),
    },
    previewStrategy: {
      renderer: "custom",
      heroAsset: pickHeroViewport(evidence),
      rationale: "All import modes should generate previews from localized source evidence and the abstracted role map, not from a hardcoded aesthetic category.",
      layoutDirectives: [
        "Use the source visual, source title hierarchy, and observed color/type relationships as the preview scaffold.",
        "Preserve dominant colors and component states observed during the rendered scroll/hover journey, even when they are not present in the first viewport.",
        "Fit the derivative preview into a stable fixed-ratio frame with no clipped text or scroll.",
        "Show style through composition, asset treatment, typography scale, and component relationships rather than explanatory prose.",
        "When evidence is weak, create a neutral evidence-backed specimen and mark confidence low.",
      ],
      avoidDirectives: [
        "Do not use a fixed house style, hardcoded brand trope, or subjective aesthetic preference.",
        "Do not invent colors, fonts, image styles, layouts, or components absent from source evidence.",
        "Do not display the design-system explanation as the visual preview.",
        "Do not treat platform chrome, browser UI, or intermediary gallery elements as the source design.",
      ],
    },
    colorRoles: {
      brandPrimary: colorRoles.brandPrimary,
      brandSecondary: colorRoles.brandSecondary,
      background: colorRoles.background,
      text: colorRoles.text,
      notes: [
        "Color roles come from source candidates and role evidence; they are not final brand approval until visually reviewed.",
        renderedColors.length ? `Rendered journey cross-check: ${renderedColors.join(", ")}.` : "Rendered journey color cross-check was not available for this import.",
        "Frequent colors may be background, text, state, decoration, or image content; downstream use must preserve the observed relationship, not the raw frequency.",
      ],
      accentPalette: buildDeterministicAccentPalette(evidence, colorRoles, tokens),
    },
    typographyRoles: {
      display,
      body,
      mono,
      rationale: [
        "Display/body/mono roles are inferred from source hierarchy, CSS candidates, and role evidence.",
        "If a font value is a CSS variable, fallback, hash, or unknown, keep it as a candidate and require review.",
      ],
    },
    spacingSystem: {
      base: tokens.spacing.baseline,
      density,
      rhythmNotes: [
        "Spacing is inferred from DOM density, section count, and source preview composition; it is not a measured design-token scale.",
        "Derivative previews must keep the source's observed density and breathing room, then mark unresolved breakpoints as review items.",
        tokens.spacing.layout,
      ],
    },
    compositionSignatures: [
      `Source mode ${evidence.sourceMode}; category label ${archetype}.`,
      `Structure evidence: ${evidence.domSignals.sectionCount} sections, ${evidence.domSignals.navCount} nav signals, ${evidence.domSignals.buttonCount} buttons, ${evidence.domSignals.imageCount} image nodes.`,
      evidence.visualCrossCheck?.steps.length ? `Rendered journey evidence: ${evidence.visualCrossCheck.steps.length} viewport/state captures; dominant fields ${renderedColors.join(", ") || "none"}.` : "Rendered journey evidence is unavailable; below-fold visual fields need manual review.",
      hasVisualAssets ? `Visual asset evidence: ${assetSignals.join(", ") || "source assets present"}.` : "Visual asset evidence is limited; preview fidelity depends on typography and layout evidence.",
      sectionRoles.length ? `Pattern evidence: ${sectionRoles.join(", ")}.` : "Pattern evidence is limited and should not be over-interpreted.",
    ],
    componentSignatures,
    componentMotionRecipes,
    interactionModel: {
      character: evidence.behaviorSignals?.length
        ? "Interaction model is inferred from captured behavior signals; preserve only observed states and mark missing states as unknown."
        : "Interaction evidence is limited; use accessible default/focus behavior and avoid decorative assumptions.",
      states: [
        "default",
        "hover/focus-visible when source or accessibility requires it",
        "active/current when source navigation or controls indicate state",
        "disabled/error/loading only when relevant to the requested output",
      ],
      motionNotes: [
        evidence.interactionSignals.hasAnimations || evidence.interactionSignals.hasTransitions ? "Captured motion exists; derive rules from the observed behavior before adding new animation." : "No strong motion was captured; keep transitions minimal and functional.",
        `Token hint: ${tokens.motion.transition}; treat as evidence, not a mandatory motion spec.`,
      ],
    },
    voiceAndBrand: {
      // Build the fallback tone from REAL voice signals (headings + button
      // copy). `evidence.sourceMode` is a routing flag ("url" / "clone-
      // website") — not a voice characteristic — so it must never leak
      // into the tone vector. Filter against the same blocklist
      // sanitizeToneArray uses so a Framer / coming-soon page with no
      // headings yields an empty tone, which the validator falls back to
      // a documented placeholder rather than `["url"]`.
      tone: (() => {
        const candidates = [
          ...evidence.headings.slice(0, 2),
          ...evidence.buttonLabels.slice(0, 2),
        ]
          .map((value) => value?.trim())
          .filter((value): value is string => Boolean(value && value.length >= 3 && !TONE_BLOCKLIST.has(value.toLowerCase())));
        const unique = uniqueStrings(candidates, 4);
        return unique.length ? unique : ["voice-pending-source-review"];
      })(),
      copyNotes: [
        "Voice must be summarized from real source copy samples, not a generic product tone.",
        "Visible preview text should stay sparse and source-like; do not print design rationale as content.",
      ],
    },
    accessibilityAndRisks: [
      "当前文档未计算真实对比度比值，正式系统应明确正文 4.5:1、大字 3:1 的约束。",
      "不能只依赖颜色表达状态；需要图标、文本或形状辅助。",
      "如果来源证据不足，迁移到产品界面或 PPT 时应重新评估可读性、裁切、字号和对比。",
    ],
    antiPatterns: [
      "不要用硬编码风格、主观审美偏好或固定模板覆盖来源证据。",
      "不要把局部装饰色、平台 UI、浏览器外壳、图库页面或中介网站元素当成来源设计系统。",
      "不要把 CSS 变量、fallback、哈希字体名或 token 频率直接写成正式规范。",
      "不要把视觉预览做成设计说明文、证据报告或内部系统文案。",
      "不要在证据不足时发明字体、色彩、图片裁切、组件形态、动效或版式结论。",
    ],
    evidenceSummary: [
      `来源域名：${evidence.sourceHost}`,
      ...(evidence.requestedSourceUrl ? [`请求来源：${evidence.requestedSourceUrl}`] : []),
      `标题样本：${headingSample}`,
      `按钮文案样本：${buttonSample}`,
      `结构信号：section ${evidence.domSignals.sectionCount}、button ${evidence.domSignals.buttonCount}、image ${evidence.domSignals.imageCount}`,
      ...(evidence.visualCrossCheck?.mediaArtifacts?.some((artifact) => artifact.kind === "video")
        ? [`Visual journey video: ${evidence.visualCrossCheck.mediaArtifacts.find((artifact) => artifact.kind === "video")?.path}`]
        : []),
      `证据置信度：${confidence}`,
    ],
    openSlideGuidance: {
      direction: "Use the same source-grounded abstraction for slides as for web previews: first source visual, then role map, then derivative page, then fidelity audit.",
      coverApproach: "The cover should use localized source visuals or a source-recognisable reconstruction; do not use an unrelated template cover.",
      layoutApproach: [
        "Match source title hierarchy, color relationship, asset treatment, layout density, and metadata/chrome before adding new content.",
        "Use section roles and capabilities as structure only when they are present in evidence.",
        "When generating a PPT derivative, compare it against source visuals and revise if the first impression drifts.",
      ],
      motionApproach: [
        "Use source-observed motion if available; otherwise keep transitions minimal and functional.",
        "Do not add motion as a style preference when evidence is missing.",
      ],
    },
    presentationStyle,
    synthesis: {
      mode: "heuristic",
      status: "heuristic-only",
      reason: "Heuristic fallback profile generated from extracted evidence.",
      promptVersion: PROMPT_VERSION,
      evidenceStats: evidenceStats(evidence),
    },
  };
  // Even pure-heuristic fallback profiles now ship with a tier-2 token
  // bundle so downstream renderers can rely on the same code path whether
  // the AI ran or not.
  base.tokens = migrateLegacyProfileTokens(base, base, evidence);
  if (motionChoreographyEnabled()) {
    const mc = buildMotionChoreography(evidence, base.tokens, base);
    if (mc) base.motionChoreography = mc;
  }
  return base;
}

function stripFences(input: string) {
  const trimmed = input.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function extractFirstJsonObject(input: string) {
  const text = stripFences(input);
  const start = text.indexOf("{");
  if (start < 0) return text;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1).trim();
    }
  }

  return text.slice(start).trim();
}

function removeTrailingJsonCommas(input: string) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(input[next] ?? "")) next += 1;
      if (input[next] === "}" || input[next] === "]") continue;
    }
    output += char;
  }
  return output;
}

function quoteUnquotedJsonKeys(input: string) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    const before = output.match(/(?:^|[{,])\s*$/);
    if (before && /[A-Za-z_$]/.test(char)) {
      let cursor = index + 1;
      while (/[A-Za-z0-9_$-]/.test(input[cursor] ?? "")) cursor += 1;
      let after = cursor;
      while (/\s/.test(input[after] ?? "")) after += 1;
      if (input[after] === ":") {
        output += `"${input.slice(index, cursor)}"`;
        index = cursor - 1;
        continue;
      }
    }

    output += char;
  }
  return output;
}

function closePossiblyTruncatedJson(input: string) {
  let output = "";
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    output += char;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      closers.push("}");
    } else if (char === "[") {
      closers.push("]");
    } else if ((char === "}" || char === "]") && closers.at(-1) === char) {
      closers.pop();
    }
  }

  if (inString) output += "\"";
  return removeTrailingJsonCommas(output) + closers.reverse().join("");
}

function parseJsonCandidate<T>(candidate: string): T {
  return JSON.parse(candidate) as T;
}

function parseLooseModelJson<T>(content: string) {
  const stripped = stripFences(content);
  const extracted = extractFirstJsonObject(stripped);
  const variants = [
    { method: "strict", value: stripped },
    { method: "extract-object", value: extracted },
    { method: "trailing-comma-repair", value: removeTrailingJsonCommas(extracted) },
    { method: "unquoted-key-repair", value: removeTrailingJsonCommas(quoteUnquotedJsonKeys(extracted)) },
    { method: "truncated-close-repair", value: closePossiblyTruncatedJson(removeTrailingJsonCommas(quoteUnquotedJsonKeys(extracted))) },
  ];
  const seen = new Set<string>();
  let lastError: unknown;

  for (const variant of variants) {
    const value = variant.value.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    try {
      return {
        parsed: parseJsonCandidate<T>(value),
        recovery: {
          method: variant.method,
          originalChars: content.length,
          candidateChars: value.length,
        },
      };
    } catch (error) {
      lastError = error;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(reason);
}

async function repairModelProfileJsonWithModel(
  config: ModelConfig,
  malformedContent: string,
  parseReason: string,
  parentDiagnostics: ModelRequestDiagnostics,
) {
  const endpoint = chatCompletionsUrl(config.baseUrl);
  const maxTokens = Math.max(2048, Math.min(4096, synthesisMaxTokens()));
  const system = "You repair malformed JSON. Return one valid compact JSON object only. Do not add markdown, comments, or explanation.";
  const user = {
    task: "Repair this malformed DesignSystemProfile JSON so JSON.parse can parse it.",
    parseError: parseReason,
    rules: [
      "Preserve existing keys and values when possible.",
      "Remove trailing commas, duplicate trailing objects, comments, markdown fences, and prose outside the JSON object.",
      "Quote property names if needed.",
      "If the object is incomplete, close the current string, array, or object. Missing fields are acceptable because a normalizer will fill them.",
      "Return JSON only.",
    ],
    malformedJson: malformedContent.slice(0, 24_000),
  };
  const requestBody = {
    model: config.model,
    ...modelTemperatureControl(config.model, 0),
    ...modelGenerationControls(config.model, maxTokens, config.baseUrl),
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) },
    ],
    ...modelJsonResponseControl(config.model),
  };
  const diagnostics = buildModelRequestDiagnostics({
    label: "Model JSON repair failed",
    endpoint,
    model: config.model,
    body: requestBody,
    timeoutMs: config.timeoutMs,
    retries: 1,
    maxTokens,
    promptVersion: `${PROMPT_VERSION}:json-repair`,
    messageContents: [system, JSON.stringify(user)],
  });
  const response = await fetchModelEndpoint(endpoint, {
    method: "POST",
    headers: modelRequestHeaders(config.apiKey),
    body: JSON.stringify(requestBody),
  }, {
    timeoutMs: config.timeoutMs,
    retries: 1,
    retryDelayMs: synthesisRetryDelayMs(),
    failureLabel: "Model JSON repair failed",
    diagnostics,
  });

  if (!response.ok) {
    throw withModelRequestDiagnostics(await modelResponseError(response), {
      ...diagnostics,
      httpStatus: response.status,
    });
  }

  const rawResponse = await response.text();
  const data = JSON.parse(rawResponse) as {
    choices?: Array<{
      finish_reason?: string;
      native_finish_reason?: string;
      message?: { content?: string | null };
    }>;
    usage?: unknown;
  };
  const choice = data.choices?.[0];
  const repairedContent = choice?.message?.content?.trim();
  if (!repairedContent) {
    throw withModelRequestDiagnostics("Model JSON repair returned empty content.", {
      ...diagnostics,
      responseChars: rawResponse.length,
      responsePreview: rawResponse.slice(0, 1000),
      finishReason: choice?.finish_reason,
      nativeFinishReason: choice?.native_finish_reason,
      messageContentChars: 0,
      usage: data.usage,
    });
  }

  const repaired = parseLooseModelJson<DesignSystemProfile>(repairedContent);
  return {
    parsed: repaired.parsed,
    recovery: {
      method: `model-repair/${repaired.recovery.method}`,
      originalChars: malformedContent.length,
      candidateChars: repaired.recovery.candidateChars,
      error: parseReason,
    },
    diagnostics: {
      ...parentDiagnostics,
      jsonRecovery: {
        method: `model-repair/${repaired.recovery.method}`,
        originalChars: malformedContent.length,
        candidateChars: repaired.recovery.candidateChars,
        error: parseReason,
      },
    },
  };
}

function compactModelText(value: string | undefined, limit: number) {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function compactEvidenceForModel(evidence: DesignEvidence) {
  return {
    title: evidence.title,
    sourceUrl: evidence.sourceUrl,
    sourceHost: evidence.sourceHost,
    sourceMode: evidence.sourceMode,
    requestedSourceUrl: evidence.requestedSourceUrl,
    description: compactModelText(evidence.description, 180),
    headings: evidence.headings.slice(0, 8),
    buttonLabels: evidence.buttonLabels.slice(0, 6),
    linkLabels: evidence.linkLabels.slice(0, 6),
    colorCandidates: evidence.colorCandidates.slice(0, 10).map((candidate) => ({
      value: candidate.value,
      count: candidate.count,
      coverage: candidate.coverage,
      source: candidate.source,
    })),
    // Strip "Unlicensed Trial" / "Placeholder" / "Fallback" candidates
    // BEFORE the AI sees them — otherwise the model occasionally promotes
    // them to display/body roles because the trial-license font name
    // (e.g. "ABC Arizona Flare") sounds plausibly descriptive.
    fontCandidates: evidence.fontCandidates.filter((f) => !isNoisyFontName(f)).slice(0, 6),
    domSignals: evidence.domSignals,
    interactionSignals: evidence.interactionSignals,
    assetSummary: evidence.assetSummary,
    sections: (evidence.sections ?? []).slice(0, 5).map((section) => ({
      role: section.role,
      label: compactModelText(section.label, 60),
      selector: compactModelText(section.selector, 55),
      headings: section.headings.slice(0, 2),
      textSample: compactModelText(section.textSample, 90),
      ctas: section.ctas.slice(0, 2),
      componentHints: section.componentHints.slice(0, 3),
      interactionHints: section.interactionHints.slice(0, 3),
    })),
    behaviorSignals: (evidence.behaviorSignals ?? []).slice(0, 7).map((signal) => ({
      kind: signal.kind,
      source: signal.source,
      selector: compactModelText(signal.selector, 50),
      evidence: compactModelText(signal.evidence, 60),
      confidence: signal.confidence,
    })),
    responsiveSignals: (evidence.responsiveSignals ?? []).slice(0, 3).map((signal) => ({
      breakpoint: compactModelText(signal.breakpoint, 60),
      evidence: compactModelText(signal.evidence, 70),
    })),
    visualCrossCheck: evidence.visualCrossCheck
      ? {
          method: evidence.visualCrossCheck.method,
          viewport: evidence.visualCrossCheck.viewport,
          pageHeight: evidence.visualCrossCheck.pageHeight,
          steps: evidence.visualCrossCheck.steps.slice(0, 7).map((step) => ({
            id: step.id,
            action: step.action,
            scrollRatio: step.scrollRatio,
            screenshotPath: step.screenshotPath,
            visibleText: step.visibleText.slice(0, 4).map((item) => compactModelText(item, 52)),
            sectionLabels: step.sectionLabels.slice(0, 2).map((item) => compactModelText(item, 56)),
            colors: step.colorCandidates.slice(0, 4).map((color) => ({
              value: color.value,
              coverage: color.coverage,
              source: color.source,
            })),
          })),
          mediaArtifacts: (evidence.visualCrossCheck.mediaArtifacts ?? []).slice(0, 8).map((artifact) => ({
            kind: artifact.kind,
            role: artifact.role,
            path: artifact.path,
            stepId: artifact.stepId,
            description: compactModelText(artifact.description, 110),
            modelEligible: artifact.modelEligible,
          })),
          dominantColors: evidence.visualCrossCheck.dominantColors.slice(0, 6),
          representativeSummary: evidence.visualCrossCheck.representativeSummary.slice(0, 5),
        }
      : undefined,
    roleEvidence: (evidence.roleEvidence ?? []).slice(0, 6).map((item) => ({
      role: item.role,
      value: item.value,
      confidence: item.confidence,
      evidence: item.evidence.slice(0, 2).map((note) => compactModelText(note, 92)),
    })),
    stateInventory: evidence.stateInventory?.slice(0, 10),
    notes: evidence.notes.slice(0, 2),
    // W1.2 deterministic visual-token signals. These are extracted by
    // grep over the static CSS bundle, frequency-counted, and (for the
    // font ratio) snapped to the nearest musical interval. The AI is
    // expected to LABEL these primitive values into semantic roles
    // (button vs card radius, posture from duration spread, etc.)
    // rather than re-invent them.
    radiusCandidates: evidence.radiusCandidates?.slice(0, 8),
    durationCandidates: evidence.durationCandidates?.slice(0, 6),
    easingCandidates: evidence.easingCandidates?.slice(0, 4),
    fontSizeRatio: evidence.fontSizeRatio
      ? {
          baseSizesPx: evidence.fontSizeRatio.sizesPx.slice(0, 10),
          detectedRatio: evidence.fontSizeRatio.detectedRatio,
          detectedRatioName: evidence.fontSizeRatio.detectedRatioName,
        }
      : undefined,
  };
}

type ModelMessage = {
  role: "system" | "user";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "low" | "high" } }
  >;
};

async function mediaInputsForModel(evidence: DesignEvidence, options?: SynthesisOptions) {
  if (!modelMediaInputsEnabled() || !options?.mediaBaseDir) return [];
  const artifacts = (evidence.visualCrossCheck?.mediaArtifacts ?? [])
    .filter((artifact) => artifact.kind === "image" && artifact.modelEligible)
    .slice(0, 5);
  const inputs: Array<{ type: "image_url"; image_url: { url: string; detail: "low" | "high" } }> = [];

  for (const artifact of artifacts) {
    const absolutePath = path.join(options.mediaBaseDir, artifact.path);
    try {
      const buffer = await readFile(absolutePath);
      if (buffer.byteLength > 1_500_000) continue;
      inputs.push({
        type: "image_url",
        image_url: {
          url: `data:${artifact.mimeType};base64,${buffer.toString("base64")}`,
          detail: "low",
        },
      });
    } catch {
      // Missing screenshots should not fail synthesis; the media manifest remains in text evidence.
    }
  }

  return inputs;
}

function modelUserContent(user: unknown, mediaInputs: Awaited<ReturnType<typeof mediaInputsForModel>>, useMedia: boolean) {
  const text = JSON.stringify(user);
  if (!useMedia || mediaInputs.length === 0) return text;
  return [
    {
      type: "text" as const,
      text: [
        "MEDIA-FIRST SOURCE CONTEXT:",
        "The attached keyframe images are the primary evidence for visual abstraction. Read them before DOM/CSS notes.",
        "Use structure, DOM, CSS, and tokens only as auxiliary material to name what the images and motion journey show.",
        text,
      ].join("\n"),
    },
    ...mediaInputs,
  ];
}

function mediaUnsupportedStatus(status: number) {
  return [400, 415, 422].includes(status);
}

/**
 * Resolve absolute paths of recorded keyframe screenshots so they can be passed
 * straight to a vision-capable CLI (currently only `claude --image`).
 * Mirrors the filtering and size cap used by `mediaInputsForModel` so the two
 * code paths cover the same set of images.
 */
async function localCliImagePaths(
  evidence: DesignEvidence,
  options?: SynthesisOptions,
): Promise<string[]> {
  if (!modelMediaInputsEnabled() || !options?.mediaBaseDir) return [];
  const artifacts = (evidence.visualCrossCheck?.mediaArtifacts ?? [])
    .filter((artifact) => artifact.kind === "image" && artifact.modelEligible)
    .slice(0, 5);
  const paths: string[] = [];
  for (const artifact of artifacts) {
    const absolutePath = path.join(options.mediaBaseDir, artifact.path);
    try {
      const stats = await stat(absolutePath);
      if (stats.size > 1_500_000) continue;
      paths.push(absolutePath);
    } catch {
      // Missing files silently skipped — parity with the BYOK media reader.
    }
  }
  return paths;
}

/**
 * Local-CLI parallel of `repairModelProfileJsonWithModel`. When the initial
 * synthesis CLI run returns malformed JSON, ask the SAME CLI to repair
 * its own output — same agent, no HTTP, reuses the CLI's existing login.
 *
 * Why this matters: codex / opencode / claude CLIs malform JSON more often
 * than HTTP API endpoints (no `response_format: { type: "json_object" }`
 * enforcement, more truncation on long outputs). Without a repair step the
 * caller throws and ingestion fails outright — the exact failure mode that
 * surfaced as `Expected double-quoted property name in JSON at position N`
 * when guizang re-imports tripped on a 24k+ char codex response.
 */
async function repairModelProfileJsonWithLocalCli(
  cli: LocalCliSelection,
  config: ModelConfig,
  malformedContent: string,
  parseReason: string,
) {
  const system = "You repair malformed JSON. Return one valid compact JSON object only. Do not add markdown, comments, or explanation.";
  const user = {
    task: "Repair this malformed DesignSystemProfile JSON so JSON.parse can parse it.",
    parseError: parseReason,
    rules: [
      "Preserve existing keys and values when possible.",
      "Remove trailing commas, duplicate trailing objects, comments, markdown fences, and prose outside the JSON object.",
      "Quote property names that are missing double quotes.",
      "If the object is incomplete, close the current string, array, or object. Missing fields are acceptable because a normalizer will fill them.",
      "Return JSON only.",
    ],
    malformedJson: malformedContent.slice(0, 24_000),
  };
  const startedAt = Date.now();
  const userText = JSON.stringify(user);
  const requestChars = system.length + userText.length;
  const result = await runCliCompletion({
    agentId: cli.agentId,
    model: cli.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
    jsonOutput: true,
    timeoutMs: config.timeoutMs,
    failureLabel: "Local CLI JSON repair failed",
  });
  const repaired = parseLooseModelJson<DesignSystemProfile>(result.content);
  return {
    parsed: repaired.parsed,
    diagnostics: {
      label: "Local CLI JSON repair",
      endpoint: `local-cli:${cli.agentId}`,
      model: cli.model,
      timeoutMs: config.timeoutMs,
      retries: 0,
      attempts: 1,
      requestChars,
      estimatedInputTokens: {
        charsPerToken4: Math.ceil(requestChars / 4),
        charsPerToken3: Math.ceil(requestChars / 3),
      },
      promptVersion: `${PROMPT_VERSION}:json-repair-cli`,
      createdAt: new Date(startedAt).toISOString(),
      durationMs: result.durationMs,
      responseChars: result.content.length,
      messageContentChars: result.content.length,
      jsonRecovery: repaired.recovery,
    } satisfies ModelRequestDiagnostics,
  };
}

/**
 * Local CLI execution path: spawns `claude -p` / `codex exec` / `opencode run`
 * as a subprocess, reusing the CLI's own login. No HTTP, no API key.
 *
 * Visual evidence parity with BYOK: when claude is the active agent and there
 * are keyframe screenshots, they are attached via `--image <path>` so the
 * model can ground motion / layout / image-rule reasoning in pixels instead
 * of guessing from DOM/CSS. codex / opencode currently lack a vision input
 * channel in their stable CLIs — they fall back to text references already
 * present in the user evidence payload.
 *
 * JSON repair mirrors the HTTP path: parseLooseModelJson runs 5 deterministic
 * variant strategies first; on full failure we ask the same CLI to fix its
 * own output before giving up.
 */
async function synthesizeWithLocalCli(
  cli: LocalCliSelection,
  config: ModelConfig,
  system: string,
  user: unknown,
  evidence: DesignEvidence,
  tokens: DesignTokens,
  options?: SynthesisOptions,
): Promise<DesignSystemProfile> {
  const startedAt = Date.now();
  const imagePaths = await localCliImagePaths(evidence, options);
  const hasImages = imagePaths.length > 0;

  // Generic MEDIA-FIRST framing — works for every supported CLI. The per-agent
  // mechanics of HOW pixels reach the model (claude's Read tool vs codex's
  // --image vs opencode's --file) are encapsulated inside cli-executor.
  const effectiveSystem = hasImages
    ? [
        system,
        "",
        "MEDIA-FIRST SOURCE CONTEXT:",
        `The page's rendered visual journey is attached as ${imagePaths.length} keyframe screenshot(s). Treat the pixels you observe (color relationships, layout rhythm, image treatment, motion choreography) as the primary evidence for visual abstraction. DOM/CSS/token data is auxiliary — use it only to name what the images already show.`,
      ].join("\n")
    : system;

  const result = await runCliCompletion({
    agentId: cli.agentId,
    model: cli.model,
    messages: [
      { role: "system", content: effectiveSystem },
      { role: "user", content: JSON.stringify(user) },
    ],
    jsonOutput: true,
    timeoutMs: config.timeoutMs,
    failureLabel: "Local CLI synthesis failed",
    imagePaths,
  });
  let parsed: DesignSystemProfile;
  let recovery: ReturnType<typeof parseLooseModelJson<DesignSystemProfile>>["recovery"];
  let repairDiagnostics: ModelRequestDiagnostics | undefined;
  try {
    const direct = parseLooseModelJson<DesignSystemProfile>(result.content);
    parsed = direct.parsed;
    recovery = direct.recovery;
  } catch (parseError) {
    const parseReason = parseError instanceof Error ? parseError.message : String(parseError);
    try {
      const repaired = await repairModelProfileJsonWithLocalCli(cli, config, result.content, parseReason);
      parsed = repaired.parsed;
      recovery = { method: "cli-repair", originalChars: result.content.length, candidateChars: result.content.length };
      repairDiagnostics = repaired.diagnostics;
    } catch (repairError) {
      const repairReason = repairError instanceof Error ? repairError.message : String(repairError);
      throw new Error(`Local CLI synthesis returned invalid JSON: ${parseReason}; CLI JSON repair failed: ${repairReason}`);
    }
  }
  const fallback = fallbackProfile(evidence, tokens);
  const normalized = normalizeModelProfile(parsed, fallback, evidence);
  normalized.synthesis = {
    mode: "model",
    model: result.model,
    provider: `local-cli:${result.agentId}`,
    status: "model-success",
    reason: hasImages
      ? `Local CLI subprocess (${result.agentId}) synthesized the design-system profile from ${imagePaths.length} keyframe image(s) + textual evidence.`
      : `Local CLI subprocess (${result.agentId}) synthesized the design-system profile from textual evidence only.`,
    durationMs: Date.now() - startedAt,
    promptVersion: PROMPT_VERSION,
    required: config.requireModel,
    evidenceStats: evidenceStats(evidence),
    modelRequest: {
      label: "Local CLI synthesis",
      endpoint: `local-cli:${result.agentId}`,
      model: result.model,
      timeoutMs: config.timeoutMs,
      retries: 0,
      attempts: 1,
      requestChars: effectiveSystem.length + JSON.stringify(user).length,
      estimatedInputTokens: {
        charsPerToken4: Math.ceil((effectiveSystem.length + JSON.stringify(user).length) / 4),
        charsPerToken3: Math.ceil((effectiveSystem.length + JSON.stringify(user).length) / 3),
      },
      mediaInputCount: imagePaths.length,
      promptVersion: PROMPT_VERSION,
      createdAt: new Date(startedAt).toISOString(),
      durationMs: result.durationMs,
      responseChars: result.content.length,
      messageContentChars: result.content.length,
      jsonRecovery: recovery,
      ...(repairDiagnostics ? { jsonRepair: repairDiagnostics } : {}),
    },
  };
  return normalized;
}

async function synthesizeWithModel(config: ModelConfig, evidence: DesignEvidence, tokens: DesignTokens, options?: SynthesisOptions): Promise<DesignSystemProfile> {
  const system = `You are a source-grounded design-system compiler. Return strict compact JSON only. Build a portable design-system profile from the provided evidence without applying personal taste, house style, or hardcoded category templates. The schema is a container, not the method: separate observed facts from inferred roles, preserve source-recognisable relationships, and mark weak evidence as unknown instead of inventing details. Do not output markdown.`;
  const modelEvidence = compactEvidenceForModel(evidence);
  const user = {
    task: "Synthesize a design system profile from website evidence.",
    requiredShape:
      "Return a sparse DesignSystemProfile JSON object using only these top-level field names when included: schemaVersion, systemName, archetype, confidence, visualThesis, summary, methodology, visualDna, previewStrategy, colorRoles, typographyRoles, spacingSystem, compositionSignatures, componentSignatures, componentMotionRecipes, interactionModel, voiceAndBrand, accessibilityAndRisks, antiPatterns, evidenceSummary, openSlideGuidance, presentationStyle, tokens. Do not invent alternative top-level schemas like name, classification, visualTheme, color, typography, spacing, layout, components, or motion. The importer will backfill omitted fields from deterministic evidence. Prefer valid compact JSON over exhaustive coverage.",
    tokensShape: {
      hint: "Two-tier token output per the methodology. The PRIMITIVE layer (tokens.primitive) carries actual values discovered in evidence; the SEMANTIC layer (tokens.semantic) is pure role-to-primitive-key labelling. Your job is mainly the SEMANTIC layer — primitive values come from evidence.radiusCandidates / durationCandidates / easingCandidates / fontSizeRatio plus the colors you already place in colorRoles / accentPalette. The importer will materialise primitive maps from those sources; you only need to fill tokens.semantic to direct the renderer.",
      canonicalRoles: CANONICAL_ROLE_GUIDE,
      surfaceDistinctInvariant: "tokens.semantic.bg.alt MUST resolve to a different primitive hex than tokens.semantic.accent.primary AND tokens.semantic.bg.default. tokens.semantic.bg.deep MUST resolve to a different primitive hex than all three (default, alt, accent). When you cannot name a third / fourth distinct identity color, OMIT the slot — leaving it undefined is better than collapsing it. The importer hard-enforces this; collisions get repaired or dropped.",
      shape: {
        primitive: {
          note: "Optional — fill ONLY if you have an additional color slot to expose that isn't already in colorRoles or accentPalette. The importer otherwise builds tokens.primitive from colorRoles + radiusCandidates + durationCandidates + easingCandidates + fontSizeRatio.",
          color: "Record<string, hex> — optional named extras",
        },
        semantic: {
          bg: { default: "primitive color KEY name e.g. \"brand\" or \"bg\" — pick the value that ACTUALLY fills >40% of the rendered viewport", alt: "second-surface KEY when site has a two-surface system (e.g. cyan hero + white pull-quote interludes)", deep: "deep-closing-surface KEY (footer/CTA band)" },
          text: { primary: "color KEY of the body-copy color — must contrast against bg.default", muted: "secondary text KEY", inverse: "KEY used when sitting on bg.deep" },
          accent: { primary: "KEY of brand accent", secondary: "KEY of supporting accent", success: "optional", warning: "optional", danger: "optional" },
          radius: { button: "radius KEY from primitive.radius (xs/sm/md/lg/xl/full)", card: "radius KEY", modal: "optional radius KEY", avatar: "usually \"full\"" },
          motion: { tap: "duration KEY from primitive.duration (fast/base/slow/emphasized)", reveal: "duration KEY", emphasized: "optional duration KEY" },
          posture: "Single enum value picked from {restrained, expressive, dramatic, playful}. Inferred from the duration distribution: tight cluster around 150-200ms with no observation > 350ms → restrained; median >300ms or many observations in 400-600ms range → dramatic; otherwise expressive. \"playful\" only when the source has explicit bouncy/elastic easing or spring physics.",
        },
      },
    },
    evidence: modelEvidence,
    extractedTokens: tokens,
    outputBudget: {
      style: "compact",
      maxArrayItems: 3,
      maxComponentSignatures: 3,
      maxComponentMotionRecipes: 3,
      maxWordsPerString: 18,
      allowSparseFields: true,
      note: "Prefer concise source-grounded decisions over exhaustive prose. Omit low-value fields instead of filling every schema slot.",
    },
    instructions: [
      // ── PRIORITY 0: rendered viewport is the truth for background and identity surface ──
      "BACKGROUND SELECTION RULE (highest priority): `colorRoles.background` is the color that fills the MAJORITY of the rendered viewport across the keyframes — NOT the highest-count entry in the CSS bundle. Pure black (#000000) and pure white (#ffffff) are ALMOST NEVER the right background unless the keyframes clearly show a black/white surface system. If `visualCrossCheck.dominantColors[0]` is a saturated color with coverage > 0.4, THAT is the background. If `visualCrossCheck.steps[].colors[0]` shows the same saturated value across most steps, THAT is the background. CSS-frequency colorCandidates are auxiliary tie-breakers, NOT the primary signal. Verify by asking: \"if I painted a wall this color and stood in the rendered keyframe, would it disappear into the background?\" That is the background.",
      "TWO-SURFACE DETECTION: if accentPalette contains entries with roles like \"interstitial-surface\", \"pullquote-section\", \"section-break\", \"alternate-band\", OR the keyframes alternate between two large surface fields (e.g. cyan hero + white pull-quote, dark hero + light catalog, light masonry + dark footer), set colorRoles.surfaceAlternate to the second surface hex. If the source has a DEEP closing band (footer / CTA / final-act dark section), set colorRoles.surfaceDeep to that hex. These two slots are NOT muted variants of the background — they are equivalent layout roles with different identities. Empty when the source genuinely has one surface; populated when it has more.",
      "SURFACE-DISTINCT INVARIANT (W4.3): `colorRoles.surfaceAlternate` MUST be a different hex from `colorRoles.brandPrimary` and from `colorRoles.background`. If the only candidate that fits your alt slot is the brand color itself, the site does not have a true alt surface — leave surfaceAlternate empty. Same for surfaceDeep vs background AND vs the alt: if you can't name a THIRD distinct identity color for the closing band, leave it empty. The downstream importer will hard-fail any collapse so emitting collisions is never preserved.",
      // ── W4.1 canonical role taxonomy ──",
      "CANONICAL ROLE TAXONOMY (W4.1): for every entry in colorRoles.accentPalette ALSO set `canonicalRole` to one of these seven values — { hero, persistent-chrome, alt-section, deep-section, accent, muted, decorative }. `role` stays free-form (your description of HOW the source uses it). `canonicalRole` is the cross-site reusable layout role. Guide: hero = first-viewport identity surface; persistent-chrome = thin always-visible bar (sticky nav, sticky footer strip, persistent CTA); alt-section = a second large surface that interleaves with bg (pull-quote band, catalog interlude); deep-section = footer / closing CTA dark band; accent = small high-saturation marker (CTA fill, badge, active dot, link tint); muted = desaturated tint for inactive controls, dividers; decorative = purely ornamental (gradient stop, sparkle, pattern wash). Pick AT MOST ONE entry per canonicalRole — if two of your accentPalette entries both look like \"hero\", merge them or demote the weaker one to decorative.",
      "TEXT/BACKGROUND CONTRAST FLOOR: `colorRoles.text` on `colorRoles.background` must clear APCA |Lc| ≥ 60 (WCAG 3.x body-copy minimum). If your candidate pair gives less, your background pick is wrong. Re-check the keyframes: the body-text color you see on each visible surface is the text; the surface itself is the bg. Saturated brand colors do not become text just because CSS frequency made them visible.",
      "FONT ROLE PROTECTION: a font name that ends in \"Light\", \"Bold\", \"Display\", \"Heavy\", \"Italic\", \"Mono\" describes a WEIGHT or STYLE variant, not its role. \"SF Pro Display Light\" is the same family as \"SF Pro Display Bold\" — the word \"Display\" in the name is just Apple's naming, not a directive to use it as the display role. Match `typographyRoles.display` to the font you observe SETTING THE LARGEST TYPE in the keyframes; match `typographyRoles.body` to the font you observe SETTING LONG-FORM PARAGRAPHS. They are often the SAME font at different weights, but they can also be different families. Don't lazily reuse one identifier for both unless the source genuinely does.",
      "FONT FAMILY NAME ONLY (W4): `typographyRoles.display / body / mono` MUST be a single font-family identifier or short CSS font-family stack — e.g. \"Documan\", \"Alpha\", \"Inter, sans-serif\". Do NOT emit prose descriptions there (no \"custom oversized NOA wordmark, not body font\"). If the actual family name is unknown from the evidence, emit the string \"unknown\" instead of a description; the importer will normalise that to a usable fallback. Description-style fields collapse to single-word identifiers downstream.",
      // ── W1.2 deterministic-evidence layer ──
      "W1.2 EVIDENCE: evidence.radiusCandidates / durationCandidates / easingCandidates / fontSizeRatio are deterministically extracted from the static CSS. Treat them as ground-truth primitive values when present. Do NOT invent radius / duration / easing / type-ratio numbers when these arrays are populated. Your job for these is purely SEMANTIC LABELLING into tokens.semantic.",
      "TOKENS.SEMANTIC OUTPUT: per the tokensShape above, output tokens.semantic with bg/text/accent/radius/motion/posture sub-objects. Values are KEYS pointing into primitive maps (e.g. semantic.bg.default = \"brand\" or \"bg\", semantic.radius.card = \"lg\", semantic.motion.tap = \"fast\"), NOT raw hex/px/ms. Posture is one of {restrained, expressive, dramatic, playful} inferred from the duration distribution.",
      "POSTURE INFERENCE: tokens.semantic.posture should reflect the SOURCE's animation character, not your taste. Enterprise / dashboard / editorial → usually restrained. Marketing landing pages with subtle hover lifts → expressive. Cinematic scroll-driven sites with long emphasized eases (Material 3 Emphasized style) → dramatic. Bouncy / spring / elastic curves explicitly observed → playful. When duration distribution is empty, omit.",
      // ── existing instructions follow ──
      "Be evidence-grounded. Do not invent Figma-perfect certainty, subjective improvements, preferred aesthetics, or template-specific details absent from the source.",
      "If image keyframes are attached, treat them as primary evidence. DOM, CSS, token frequency, and structure are auxiliary labels only.",
      "For motion-heavy, cinematic, spatial, WebGL/canvas, scroll-driven, or image-led sites, preserve camera/crop/perspective, depth, masking, scale, rotation, parallax, and transition choreography as first-class design-system traits.",
      "Do visual-design reasoning before filling fields: rendered journey, color relationship, typography hierarchy, layout rhythm, asset treatment, component behavior, interaction character, and anti-patterns.",
      "Abstract both process and result: process means load, scroll, viewport, and safe hover states; result means the representative visual conclusion that survives those states.",
      "Use visualCrossCheck as cross-check evidence over CSS/DOM frequency. A large color field observed after scrolling is representative even if it is absent from the first viewport.",
      "If rendered journey evidence conflicts with static token frequency, preserve the rendered relationship and mark the static-only inference as lower confidence.",
      "The profile will become a 9-section portable DESIGN.md like Open Design: Visual Theme, Color, Typography, Spacing, Layout, Components, Motion, Voice, Anti-patterns.",
      "Also derive a presentation transfer grammar in presentationStyle using the same source-grounded rules: source visual first, role map second, derivative specimen third, fidelity audit last.",
      "presentationStyle.slideArchetypes should include preview-ready samples for title layout, data display, image display, single-module text, and multi-module/workflow text only when they can be kept compact; the normalizer will add missing required archetypes.",
      "For workflow, progress, supply-chain, agent handoff, review, risk, or human-in-loop content, specify diagram-first PPT rules: nodes, lanes, connectors, status chips, simple CSS icon primitives, and minimal paragraph text.",
      "Do not describe presentation style as vague adjectives. Write executable rules another generator can verify against source evidence.",
      "Write componentSignatures as reusable recipes only for observed or documented components/patterns: role, visual construction, density, states, evidence gaps, and what not to change.",
      "Write componentMotionRecipes as executable micro-interaction recipes for observed behavior only. Each recipe needs component, role, trigger, statePair, properties, timing, choreography, cssHint, pptAdapter, evidence, and confidence.",
      "For componentMotionRecipes, translate source motion into PPT behavior: hover becomes staged emphasis, sticky becomes persistent slide chrome, scroll/animation becomes slide-enter or masked reveal, tabs/accordion/dialog become before-after or active-state choreography.",
      "If motion evidence is weak, output one low-confidence minimal recipe rather than inventing decorative animation.",
      "Use neutral archetype labels such as source-derived web style system, source-derived presentation system, source-derived component system, or source-derived interactive visual system.",
      "Do not classify by brand examples, domain stereotypes, or fixed visual genres. Classification is only a routing label, never permission to inject a template.",
      "Use previewStrategy to tell downstream renderers what source relationships to preserve. Prefer custom unless a renderer is directly justified by localized source visuals or explicit project files.",
      "Reproduce the source's color decisions as-observed in the keyframes. Do not adjust them toward any aesthetic template, brand archetype, or 'what a brand should look like' assumption. If the source is monochrome, output a monochrome colorRoles; if it uses multiple distinct saturated fields, preserve them; if it pairs a neutral surface with a single saturated accent, encode exactly that pairing. The only success criterion for colorRoles is source-recognition.",
      "Extracted colorCandidates report how often each color is RENDERED, not which color carries identity. A surface that fills the viewport renders many times; a hero treatment may render once but anchor recognition. Use the keyframe images — not the count column — to decide which value belongs to which role.",
      "colorRoles.text and colorRoles.background must have a perceived-luminance separation a reader can see (treat WCAG 4.5:1 as the lower bound). If your candidates fall in the same luminance band, the keyframes show which value is body copy and which is the surface — use them to disambiguate.",
      "When the source uses MORE than two saturated fields, the 4-slot brandPrimary / brandSecondary / background / text is too narrow. Fill the additional saturated values into colorRoles.accentPalette, a variable-length array of { hex, role, coverage, evidence } objects. Downstream renderers read this array as the authoritative palette — values that never appear in accentPalette will never reach the generated slides or web preview, no matter how clearly visualThesis describes them. Always encode every saturated identity color that is visible in the keyframes here.",
      "accentPalette.role should describe HOW the source uses the color, not what kind of color it is. Use values like \"hero-fill\", \"panel-accent\", \"active-state\", \"decorative-marker\", \"chart-axis\", \"hover-highlight\", \"oversized-display-type\". accentPalette.coverage records observed prevalence (\"87% max viewport coverage\", \"spot accent on CTAs\", \"repeated 5% chrome\"). accentPalette.evidence cites the keyframe(s) where you saw it.",
      "brandPrimary and brandSecondary may simply reference values from accentPalette by repeating the hex when you have to pick one anchor. Do not invent a muted compromise color for those slots when accentPalette already enumerates the real identity colors.",
      "If the extracted typography looks unreliable, say so and keep roles as candidates instead of naming a preferred font.",
      "Write anti-patterns that prevent source drift, hallucinated style, platform chrome leakage, and prose-report previews.",
      "Explicitly say what would make a generated web or PPT derivative preview fail source fidelity.",
      "presentationStyle.qualityChecks should prioritize source-recognition, theme-rhythm, slide-archetype, type-role, image-rule, motion-rule, and anti-pattern checks; omit if it would make output verbose.",
      "Keep componentSignatures to 2-3 items and each traits/states array to 1-2 short items.",
      "Keep componentMotionRecipes to 1-3 items and keep choreography/pptAdapter arrays compact.",
      "Keep presentationStyle arrays to 2-4 short items; do not restate source excerpts.",
      "Keep strings short and arrays selective; the downstream normalizer will fill mechanical checklist gaps.",
      "Use the requested top-level field names exactly; do not output parallel schemas or renamed sections.",
      "Output valid compact JSON only.",
    ],
  };

  const runtime = getModelRuntimeConfig();
  if (runtime.mode === "local-cli" && runtime.localCli) {
    return synthesizeWithLocalCli(runtime.localCli, config, system, user, evidence, tokens, options);
  }

  const startedAt = Date.now();
  const endpoint = chatCompletionsUrl(config.baseUrl);
  const maxTokens = synthesisMaxTokens();
  const retries = synthesisRetries();
  const mediaInputs = await mediaInputsForModel(evidence, options);
  const userText = JSON.stringify(user);
  const buildRequestBody = (useMedia: boolean) => {
    const messages: ModelMessage[] = [
      { role: "system", content: system },
      { role: "user", content: modelUserContent(user, mediaInputs, useMedia) },
    ];
    return {
      model: config.model,
      ...modelTemperatureControl(config.model, 0.2),
      ...modelGenerationControls(config.model, maxTokens, config.baseUrl),
      messages,
      ...modelJsonResponseControl(config.model),
    };
  };
  const buildDiagnostics = (requestBody: ReturnType<typeof buildRequestBody>, useMedia: boolean) => buildModelRequestDiagnostics({
    label: "Model synthesis failed",
    endpoint,
    model: config.model,
    body: requestBody,
    timeoutMs: config.timeoutMs,
    retries,
    maxTokens,
    promptVersion: PROMPT_VERSION,
    evidence: modelEvidence,
    messageContents: [system, userText],
    mediaInputCount: useMedia ? mediaInputs.length : 0,
  });
  const fetchSynthesis = async (requestBody: ReturnType<typeof buildRequestBody>, requestDiagnostics: ModelRequestDiagnostics) => fetchModelEndpoint(endpoint, {
    method: "POST",
    headers: modelRequestHeaders(config.apiKey),
    body: JSON.stringify(requestBody),
  }, {
    timeoutMs: config.timeoutMs,
    retries,
    retryDelayMs: synthesisRetryDelayMs(),
    failureLabel: "Model synthesis failed",
    diagnostics: requestDiagnostics,
  });

  let usedMediaInputs = mediaInputs.length > 0;
  let requestBody = buildRequestBody(usedMediaInputs);
  let diagnostics = buildDiagnostics(requestBody, usedMediaInputs);
  let response = await fetchSynthesis(requestBody, diagnostics);
  if (!response.ok && usedMediaInputs && mediaUnsupportedStatus(response.status)) {
    const mediaError = await modelResponseError(response);
    usedMediaInputs = false;
    requestBody = buildRequestBody(false);
    diagnostics = {
      ...buildDiagnostics(requestBody, false),
      errorParts: [`media input retry: ${mediaError}`],
    };
    response = await fetchSynthesis(requestBody, diagnostics);
  }

  if (!response.ok) {
    throw withModelRequestDiagnostics(await modelResponseError(response), {
      ...diagnostics,
      durationMs: Date.now() - startedAt,
      httpStatus: response.status,
    });
  }

  try {
    const rawResponse = await response.text();
    const data = JSON.parse(rawResponse) as {
      choices?: Array<{
        finish_reason?: string;
        native_finish_reason?: string;
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
        };
      }>;
      usage?: unknown;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim();
    let responseDiagnostics: ModelRequestDiagnostics = {
      ...diagnostics,
      durationMs: Date.now() - startedAt,
      responseChars: rawResponse.length,
      responsePreview: rawResponse.slice(0, 1000),
      finishReason: choice?.finish_reason,
      nativeFinishReason: choice?.native_finish_reason,
      messageContentChars: choice?.message?.content?.length ?? 0,
      usage: data.usage,
    };
    if (!content) {
      throw withModelRequestDiagnostics(
        [
          "Model synthesis returned empty content.",
          choice?.finish_reason ? `finish_reason=${choice.finish_reason}` : undefined,
          choice?.native_finish_reason ? `native_finish_reason=${choice.native_finish_reason}` : undefined,
          choice?.message?.reasoning_content ? "reasoning_content was present but content was empty" : undefined,
        ].filter(Boolean).join(" "),
        responseDiagnostics,
      );
    }
    let parsed: DesignSystemProfile;
    try {
      const result = parseLooseModelJson<DesignSystemProfile>(content);
      parsed = result.parsed;
      responseDiagnostics = {
        ...responseDiagnostics,
        jsonRecovery: result.recovery,
      };
    } catch (parseError) {
      const reason = parseError instanceof Error ? parseError.message : String(parseError);
      try {
        const repaired = await repairModelProfileJsonWithModel(config, content, reason, responseDiagnostics);
        parsed = repaired.parsed;
        responseDiagnostics = {
          ...responseDiagnostics,
          ...repaired.diagnostics,
          durationMs: Date.now() - startedAt,
          responsePreview: content.slice(0, 1000),
        };
      } catch (repairError) {
        const repairReason = repairError instanceof Error ? repairError.message : String(repairError);
        throw withModelRequestDiagnostics(`Model synthesis returned invalid JSON: ${reason}; JSON repair failed: ${repairReason}`, {
          ...responseDiagnostics,
          responsePreview: content.slice(0, 1000),
        });
      }
    }
    const fallback = fallbackProfile(evidence, tokens);
    const normalized = normalizeModelProfile(parsed, fallback, evidence);
    normalized.synthesis = {
      mode: "model",
      model: config.model,
      provider: "openai-compatible",
      status: "model-success",
      reason: "AI model synthesized the design-system profile from extracted website evidence.",
      durationMs: Date.now() - startedAt,
      promptVersion: PROMPT_VERSION,
      required: config.requireModel,
      evidenceStats: evidenceStats(evidence),
      modelRequest: {
        ...responseDiagnostics,
      },
    };
    return normalized;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const errorDiagnostics = getModelRequestDiagnostics(error);
    throw withModelRequestDiagnostics(`Model synthesis post-processing failed: ${reason}`, {
      ...diagnostics,
      ...errorDiagnostics,
      durationMs: Date.now() - startedAt,
    });
  }
}

export async function synthesizeDesignProfile(evidence: DesignEvidence, tokens: DesignTokens, options?: SynthesisOptions): Promise<DesignSystemProfile> {
  loadLocalModelEnv();
  const runtime = getModelRuntimeConfig();

  // Local CLI mode: build a synthetic ModelConfig — baseUrl/apiKey are unused
  // because synthesizeWithModel detects mode and routes to subprocess instead.
  let config: ModelConfig | null;
  if (runtime.mode === "local-cli" && runtime.localCli) {
    config = {
      baseUrl: "local-cli://" + runtime.localCli.agentId,
      apiKey: "local-cli-no-key-required",
      model: runtime.localCli.model,
      requireModel: runtime.requireModel,
      timeoutMs: runtime.timeoutMs,
    };
  } else {
    config = getModelConfig();
  }

  if (!config) {
    const reason = runtime.mode === "local-cli"
      ? "Local CLI mode is selected, but no CLI agent is configured."
      : "DESIGN_VAULT_MODEL_BASE_URL and DESIGN_VAULT_MODEL_API_KEY are not both configured.";
    if (modelRequired()) {
      throw new Error(`AI model synthesis is required, but skipped: ${reason}`);
    }
    return fallbackWithTrace(evidence, tokens, "model-skipped", reason);
  }

  const startedAt = Date.now();
  try {
    return await synthesizeWithModel(config, evidence, tokens, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const modelRequest = getModelRequestDiagnostics(error);
    if (config.requireModel) {
      throw withModelRequestDiagnostics(`AI model synthesis is required, but failed: ${reason}`, modelRequest);
    }
    return fallbackWithTrace(evidence, tokens, "model-failed", reason, Date.now() - startedAt, modelRequest);
  }
}

export function synthesizeLegacyProfile(meta: Pick<DesignMeta, "title" | "summary" | "sourceHost" | "sourceMode" | "tokens" | "assets">): DesignSystemProfile {
  const evidence: DesignEvidence = {
    title: meta.title,
    sourceUrl: "",
    sourceHost: meta.sourceHost,
    sourceMode: meta.sourceMode,
    description: meta.summary,
    headings: [meta.title],
    buttonLabels: [],
    linkLabels: [],
    colorCandidates: Object.values(meta.tokens.colors).map((value) => ({ value, count: 1 })),
    fontCandidates: Object.values(meta.tokens.typography.families),
    domSignals: {
      headingCount: 1,
      sectionCount: 0,
      buttonCount: 0,
      linkCount: 0,
      imageCount: meta.assets.filter((asset) => asset.kind === "image").length,
      formCount: 0,
      navCount: 0,
      cardLikeCount: 0,
    },
    interactionSignals: {
      hasHoverStyles: false,
      hasAnimations: false,
      hasTransitions: false,
      hasStickyElements: false,
      hasScrollSnap: false,
      hasForms: false,
    },
    assetSummary: {
      total: meta.assets.length,
      icons: meta.assets.filter((asset) => asset.kind === "icon").length,
      images: meta.assets.filter((asset) => asset.kind === "image").length,
      logos: meta.assets.filter((asset) => asset.kind === "logo").length,
      svgs: meta.assets.filter((asset) => asset.kind === "svg").length,
      videos: meta.assets.filter((asset) => asset.kind === "video").length,
    },
    notes: ["Legacy entry synthesized from previously stored metadata; evidence quality is limited."],
  };

  return fallbackProfile(evidence, meta.tokens);
}
