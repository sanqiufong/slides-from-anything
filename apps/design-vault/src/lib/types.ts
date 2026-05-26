import type { ModelRequestDiagnostics } from "./model-request";

export type IngestMode = "url" | "clone-website" | "design-system-project" | "canva-template" | "canva-editor";

export type DesignSystemPackageType = "component-system" | "presentation-system" | "visual-style-system" | "agent-skill-package";

export type DesignSystemSourceKind = "github-repo" | "npm-package" | "zip-archive" | "project-url" | "canva-template" | "canva-editor";

export type DesignSystemCapabilityCategory = "component" | "layout" | "pattern" | "token" | "asset" | "workflow" | "adapter";

export type DesignSystemCapability = {
  id: string;
  label: string;
  category: DesignSystemCapabilityCategory;
  description: string;
  usage: string;
  evidence: string[];
  sourcePaths: string[];
};

export type SkillPackageMeta = {
  name: string;
  path: string;
  entrypoint: string;
  referencePrompt: string;
  installCommand: string;
  references: string[];
};

export type DesignSystemPackageManifest = {
  schemaVersion: "1.0";
  id: string;
  name: string;
  packageType: DesignSystemPackageType;
  secondaryTypes: DesignSystemPackageType[];
  confidence: "low" | "medium" | "high";
  summary: string;
  bestFor: string[];
  notFor: string[];
  capabilities: string[];
  source: {
    input: string;
    kind: DesignSystemSourceKind;
    normalizedUrl?: string;
    host?: string;
    packageName?: string;
    repository?: string;
    version?: string;
    commit?: string;
    license: string;
    fetchedAt: string;
  };
  local: {
    root: string;
    vendorDir: string;
    manifestPath: string;
    capabilitiesPath: string;
    skillDir: string;
    productPath?: string;
    designSpecPath?: string;
    styleCardPath?: string;
    antiPatternsPath?: string;
    qualityGatesPath?: string;
    routerSkillPath?: string;
  };
  skill: SkillPackageMeta;
  riskNotes: string[];
};

export type AssetKind = "icon" | "image" | "logo" | "svg" | "video";

export type AssetRecord = {
  name: string;
  kind: AssetKind;
  path: string;
  sourceUrl?: string;
};

export type SourceChainEntry = {
  role: "requested" | "showcase" | "primary";
  url: string;
  host: string;
  title?: string;
  note: string;
};

export type ColorTokenSet = {
  primary: string;
  secondary: string;
  success: string;
  warning: string;
  danger: string;
  surface: string;
  text: string;
  neutral: string;
};

export type DesignTokens = {
  colors: ColorTokenSet;
  typography: {
    scale: string[];
    families: {
      primary: string;
      display: string;
      mono: string;
    };
    weights: string[];
  };
  spacing: {
    baseline: string;
    layout: string;
  };
  motion: {
    transition: string;
    easing: string;
    notes: string[];
  };
};

export type InteractionSignals = {
  hasHoverStyles: boolean;
  hasAnimations: boolean;
  hasTransitions: boolean;
  hasStickyElements: boolean;
  hasScrollSnap: boolean;
  hasForms: boolean;
};

export type DomSignals = {
  headingCount: number;
  sectionCount: number;
  buttonCount: number;
  linkCount: number;
  imageCount: number;
  formCount: number;
  navCount: number;
  cardLikeCount: number;
};

export type ExtractedSection = {
  id: string;
  order: number;
  tag: string;
  selector: string;
  role:
    | "nav"
    | "hero"
    | "content"
    | "feature"
    | "pricing"
    | "faq"
    | "sponsor"
    | "form"
    | "footer"
    | "unknown";
  label: string;
  headings: string[];
  textSample: string;
  ctas: string[];
  links: string[];
  assetRefs: string[];
  componentHints: string[];
  interactionHints: string[];
};

export type BehaviorSignal = {
  kind:
    | "hover"
    | "sticky"
    | "fixed"
    | "transition"
    | "animation"
    | "scroll-snap"
    | "form"
    | "tabs"
    | "accordion"
    | "carousel"
    | "dialog"
    | "state"
    | "unknown";
  source: "css" | "dom" | "attribute" | "class";
  selector: string;
  evidence: string;
  confidence: "low" | "medium" | "high";
};

export type ResponsiveSignal = {
  breakpoint: string;
  evidence: string;
  affectedSelectors: string[];
};

export type RenderedColorCandidate = {
  value: string;
  coverage: number;
  count: number;
  source: "background" | "text" | "border" | "graphic";
  sample: string;
  stepId?: string;
};

export type VisualJourneyStep = {
  id: string;
  action: "load" | "scroll" | "hover";
  y: number;
  scrollRatio: number;
  screenshotPath?: string;
  visibleText: string[];
  sectionLabels: string[];
  colorCandidates: RenderedColorCandidate[];
  notes: string[];
};

export type VisualMediaArtifact = {
  kind: "image" | "video";
  path: string;
  mimeType: string;
  role: "keyframe" | "motion-journey";
  stepId?: string;
  description: string;
  modelEligible: boolean;
};

export type VisualCrossCheck = {
  method: "rendered-scroll-journey" | "media-first-rendered-journey";
  capturedAt: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  pageHeight: number;
  steps: VisualJourneyStep[];
  mediaArtifacts?: VisualMediaArtifact[];
  dominantColors: Array<{
    value: string;
    coverage: number;
    seenInSteps: number;
    roleHint?: string;
  }>;
  representativeSummary: string[];
  warnings: string[];
};

export type RoleEvidence = {
  role: "background" | "text" | "accent" | "secondary" | "display-font" | "body-font" | "mono-font";
  value: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
};

export type DesignEvidence = {
  title: string;
  sourceUrl: string;
  sourceHost: string;
  sourceMode: IngestMode;
  requestedSourceUrl?: string;
  sourceChain?: SourceChainEntry[];
  description: string;
  headings: string[];
  buttonLabels: string[];
  linkLabels: string[];
  colorCandidates: Array<{ value: string; count: number; source?: "css" | "rendered"; coverage?: number }>;
  fontCandidates: string[];
  /**
   * Deterministic visual-token signals extracted from the source CSS in
   * W1.2. Populated by `extractRadius/Duration/Easing/FontSizeRatio`
   * in ingestion.ts. Optional during the migration window: existing
   * evidence files predate these fields and the synthesiser still
   * functions with defaults.
   */
  radiusCandidates?: Array<{ px: number; count: number }>;
  durationCandidates?: Array<{ ms: number; count: number }>;
  easingCandidates?: Array<{ curve: string; count: number }>;
  fontSizeRatio?: {
    sizesPx: number[];
    detectedRatio: number;
    detectedRatioName: string;
  };
  domSignals: DomSignals;
  interactionSignals: InteractionSignals;
  assetSummary: {
    total: number;
    icons: number;
    images: number;
    logos: number;
    svgs: number;
    videos: number;
  };
  sections?: ExtractedSection[];
  behaviorSignals?: BehaviorSignal[];
  responsiveSignals?: ResponsiveSignal[];
  visualCrossCheck?: VisualCrossCheck;
  roleEvidence?: RoleEvidence[];
  stateInventory?: string[];
  notes: string[];
};

export type ComponentSignature = {
  name: string;
  role: string;
  traits: string[];
  states: string[];
};

export type ComponentMotionRecipe = {
  id: string;
  component: string;
  role: string;
  trigger: string;
  statePair: string;
  properties: string[];
  timing: {
    duration: string;
    easing: string;
    delay?: string;
    stagger?: string;
  };
  choreography: string[];
  cssHint: string;
  pptAdapter: string[];
  evidence: string[];
  confidence: "low" | "medium" | "high";
};

export type DesignQualityGate = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  score: number;
  maxScore: number;
  evidence: string[];
  recommendation: string;
};

export type DesignQualityReport = {
  schemaVersion: "1.0";
  score: number;
  threshold: number;
  grade: "production-9plus" | "needs-review" | "blocked";
  summary: string;
  gates: DesignQualityGate[];
};

export type PresentationStyleGuide = {
  narrativeArc: string[];
  themeRhythm: {
    paletteRule: string;
    lightDarkPattern: string[];
    emphasisCadence: string[];
  };
  slideArchetypes: Array<{
    name: string;
    use: string;
    construction: string[];
  }>;
  typographyHierarchy: string[];
  imageRules: string[];
  motionRecipes: string[];
  chromeAndMetadata: string[];
  qualityChecks: string[];
};

/**
 * Primitive token layer: raw values discovered by deterministic extraction
 * from CSS bundles and rendered keyframe analysis. Keys are short
 * identifiers (`green-500`, `radius-md`, `motion-fast`) that the semantic
 * layer references by name; values are the actual renderable strings.
 *
 * The AI never invents primitive values directly — they originate from
 * grep-extracted CSS, rendered viewport color analysis, or hard-coded
 * fallbacks. This is the layer that makes the "single source of truth"
 * promise enforceable: change one primitive, every consumer downstream
 * picks it up.
 */
export type ProfileTokensPrimitive = {
  /** Hex colors observed in the source, role-tagged by frequency. */
  color: Record<string, string>;
  /** Spacing scale in px (e.g. `{ "1":"4px","2":"8px","3":"12px","4":"16px","6":"24px","8":"32px","12":"48px" }`). */
  space: Record<string, string>;
  /** Border-radius scale; conventional keys: `xs sm md lg xl full`. */
  radius: Record<string, string>;
  /** Font-size scale derived from observed sizes + their geometric ratio. */
  fontSize: Record<string, string>;
  /** Motion duration in milliseconds. Conventional keys: `fast base slow emphasized`. */
  duration: Record<string, number>;
  /** Easing curves as cubic-bezier strings. Conventional keys: `standard accelerate decelerate emphasized`. */
  easing: Record<string, string>;
};

/**
 * Semantic token layer: role labels that point at primitive keys. The AI's
 * job here is purely to LABEL — given the primitive table, decide which
 * green is the brand and which is decorative, which radius is for buttons
 * vs cards, etc. The values inside this object are KEYS into
 * `ProfileTokensPrimitive`, never raw colors / px / ms.
 */
export type ProfileTokensSemantic = {
  bg: {
    /** Dominant background surface key (e.g. "white" or "green-500"). */
    default: string;
    /** Optional secondary surface for editorial split layouts. */
    alt?: string;
    /** Optional deep / closing surface for footer / CTA caps. */
    deep?: string;
  };
  text: {
    primary: string;
    muted?: string;
    /** Color used when sitting on `bg.deep` or any high-contrast inversion. */
    inverse?: string;
  };
  accent: {
    primary: string;
    secondary?: string;
    success?: string;
    warning?: string;
    danger?: string;
  };
  radius: {
    /** Default radius for inline controls (buttons, inputs, chips). */
    button: string;
    /** Container radius for cards / panels. */
    card: string;
    /** Modal / dialog radius (usually one step larger than card). */
    modal?: string;
    /** Avatar / pill (typically `full`). */
    avatar?: string;
  };
  motion: {
    /** Snappy feedback for taps / toggles (≈150ms). */
    tap: string;
    /** Reveal / expand transitions (≈220ms). */
    reveal: string;
    /** Dramatic emphasis motions (≈320-500ms). */
    emphasized?: string;
  };
  /**
   * Brand posture classification — a single enum value the renderer reads
   * to pick the right easing curves. The methodology lets a brand's
   * personality (Ant Design's "restrained", Material 3's "dramatic") show
   * up in motion physics, not just naming.
   */
  posture?: "restrained" | "expressive" | "dramatic" | "playful";
};

export type ProfileTokens = {
  primitive: ProfileTokensPrimitive;
  semantic: ProfileTokensSemantic;
};

export type DesignSystemProfile = {
  schemaVersion: "2.0";
  systemName: string;
  archetype: string;
  confidence: "low" | "medium" | "high";
  visualThesis: string;
  summary: string;
  methodology?: {
    sourceOfTruth: string[];
    abstractionSteps: string[];
    fidelityChecks: string[];
  };
  visualDna?: {
    colorAtmosphere: string;
    typographySignal: string;
    layoutGrammar: string;
    componentLanguage: string;
    motionCharacter: string;
    mustPreserve: string[];
  };
  previewStrategy?: {
    renderer: "consumer-wallet" | "dark-event" | "immersive-experiment" | "type-specimen" | "product-system" | "editorial" | "campaign" | "institutional" | "custom";
    rationale: string;
    layoutDirectives: string[];
    avoidDirectives: string[];
  };
  colorRoles: {
    brandPrimary: string;
    brandSecondary: string;
    background: string;
    text: string;
    notes: string[];
    /**
     * Optional secondary surface used by editorial layouts that alternate
     * between two large surface fields (e.g. cyan sky + white pull-quote
     * sections). When set, downstream renderers should treat it as a
     * "second background" — equivalent layout role to `background` but
     * with a different color identity, not a muted variant.
     */
    surfaceAlternate?: string;
    /**
     * Optional deep / closing surface used for footer + CTA sections that
     * cap the scroll with a heavier color (e.g. dark teal #082a38 under a
     * cyan-dominated page). Higher contrast than `background`; not the
     * same as `text`.
     */
    surfaceDeep?: string;
    /**
     * Variable-length saturated / distinctive palette observed in the source,
     * for systems whose identity does not fit four flat slots. Downstream
     * renderers (slide decks, web previews) should consume this array as the
     * authoritative palette and treat brandPrimary/Secondary as defaults
     * that can fall back to its entries.
     */
    accentPalette?: Array<{
      hex: string;
      /** "hero-fill", "panel-accent", "active-state", "decorative-marker", … */
      role?: string;
      /**
       * One of the seven W4 canonical layout roles
       * (hero / persistent-chrome / alt-section / deep-section / accent /
       * muted / decorative). Free-form `role` above is kept for the model's
       * own description; this one is the cross-site reusable key the
       * compiler turns into `--dv-color-role-<canonical>`.
       */
      canonicalRole?: import("./role-taxonomy").CanonicalRole;
      /** "87% max viewport coverage", "spot accent", "repeated 5% chrome", … */
      coverage?: string;
      /** "Observed in hero section across keyframes 1–3" — source trace. */
      evidence?: string;
    }>;
  };
  typographyRoles: {
    display: string;
    body: string;
    mono: string;
    rationale: string[];
  };
  spacingSystem: {
    base: string;
    density: string;
    rhythmNotes: string[];
  };
  /**
   * Tier-2 (semantic) tokens that downstream renderers consume.
   *
   * Two-tier discipline borrowed from Material / Fluent / Ant Design:
   *   - `primitive` is the value layer: raw hex strings, raw pixel values,
   *     raw cubic-bezier strings. Discovered by deterministic extraction
   *     (ingestion.ts), not invented by the AI.
   *   - `semantic` is the role layer: maps known roles (`bg.default`,
   *     `radius.card`, `motion.tap`, `text.muted`) to specific primitive
   *     keys. The AI's job is to PICK keys, not invent values.
   *
   * Renderers should NEVER emit raw hex/px/ms from this profile — they must
   * emit CSS variable references that ultimately resolve to a primitive.
   * That single discipline is what gives the system its "real brand
   * fingerprint" feel under nesting, dark mode, and responsive breakpoints.
   *
   * Optional during the migration window. `migrateLegacyProfileTokens()` in
   * synthesis.ts populates this from the legacy `colorRoles + typographyRoles
   * + spacingSystem` triple when a profile predates the tier-2 schema.
   */
  tokens?: ProfileTokens;
  compositionSignatures: string[];
  componentSignatures: ComponentSignature[];
  componentMotionRecipes?: ComponentMotionRecipe[];
  interactionModel: {
    character: string;
    states: string[];
    motionNotes: string[];
  };
  voiceAndBrand: {
    tone: string[];
    copyNotes: string[];
  };
  accessibilityAndRisks: string[];
  antiPatterns: string[];
  evidenceSummary: string[];
  openSlideGuidance: {
    direction: string;
    coverApproach: string;
    layoutApproach: string[];
    motionApproach: string[];
  };
  presentationStyle?: PresentationStyleGuide;
  synthesis: {
    mode: "heuristic" | "model";
    model?: string;
    provider?: "openai-compatible" | "local-cli:claude" | "local-cli:codex" | "local-cli:opencode" | string;
    status?: "model-success" | "model-skipped" | "model-failed" | "heuristic-only";
    reason?: string;
    durationMs?: number;
    promptVersion?: string;
    required?: boolean;
    evidenceStats?: {
      headings: number;
      buttons: number;
      links: number;
      colors: number;
      fonts: number;
      sections: number;
      behaviorSignals: number;
      responsiveSignals: number;
      visualSteps?: number;
    };
    modelRequest?: ModelRequestDiagnostics;
  };
  quality?: DesignQualityReport;
};

export type DesignOrigin = "local" | "community";

export type CommunityProvenance = {
  origin: "community";
  bundleVersion: number;
  bundleId?: string;
  publisher?: string;
  installedAt: string;
  installedFrom?: string;
  upstreamSlug?: string;
};

export type DesignMeta = {
  slug: string;
  title: string;
  sourceUrl: string;
  sourceHost: string;
  sourceMode: IngestMode;
  requestedSourceUrl?: string;
  sourceChain?: SourceChainEntry[];
  status: "ready";
  summary: string;
  tags?: string[];
  origin?: DesignOrigin;
  community?: CommunityProvenance;
  createdAt: string;
  updatedAt: string;
  designPath: string;
  openSlideThemePath: string;
  evidencePath: string;
  profilePath: string;
  productPath?: string;
  designSpecPath?: string;
  styleCardPath?: string;
  antiPatternsPath?: string;
  qualityGatesPath?: string;
  routerSkillPath?: string;
  manifestPath?: string;
  capabilitiesPath?: string;
  skillPath?: string;
  packageManifest?: DesignSystemPackageManifest;
  capabilities?: DesignSystemCapability[];
  assets: AssetRecord[];
  previews: {
    web: string;
    ppt: string;
    card?: string;
  };
  tokens: DesignTokens;
  profile: DesignSystemProfile;
};

export type IngestionJob = {
  id: string;
  url: string;
  mode: IngestMode;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  stage?:
    | "queued"
    | "fetching-source"
    | "resolving-source"
    | "capturing-visuals"
    | "collecting-assets"
    | "synthesizing-profile"
    | "rendering-previews"
    | "writing-output"
    | "completed"
    | "failed";
  stageLabel?: string;
  progress?: number;
  lastHeartbeatAt?: string;
  slug?: string;
  targetSlug?: string;
  workerLogPath?: string;
  error?: string;
  diagnostics?: {
    modelRequest?: ModelRequestDiagnostics;
  };
};
