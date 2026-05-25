import { apcaContrast, apcaTier } from "./color-math";
import type { DesignEvidence, DesignMeta, DesignQualityGate, DesignQualityReport, DesignSystemProfile, DesignTokens } from "./types";

type PreviewHtml = {
  web?: string;
  ppt?: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function gateStatus(score: number, maxScore: number, forceFail = false): DesignQualityGate["status"] {
  if (forceFail) return "fail";
  const ratio = maxScore === 0 ? 0 : score / maxScore;
  if (ratio >= 0.84) return "pass";
  if (ratio >= 0.55) return "warn";
  return "fail";
}

function makeGate(
  id: string,
  label: string,
  maxScore: number,
  rawScore: number,
  evidence: string[],
  recommendation: string,
  forceFail = false,
  statusOverride?: DesignQualityGate["status"],
): DesignQualityGate {
  const score = clamp(Math.round(rawScore), 0, maxScore);
  return {
    id,
    label,
    maxScore,
    score,
    status: statusOverride ?? gateStatus(score, maxScore, forceFail),
    evidence,
    recommendation,
  };
}

function isSpecificRenderer(renderer: string | undefined) {
  return Boolean(renderer && renderer !== "product-system" && renderer !== "custom");
}

function isGenericArchetype(archetype: string) {
  return /^(product|product-system|website|landing|generic|system)$/i.test(archetype.trim());
}

function hasHashFontLeak(tokens: DesignTokens, profile: DesignSystemProfile) {
  const corpus = [
    tokens.typography.families.primary,
    tokens.typography.families.display,
    tokens.typography.families.mono,
    profile.typographyRoles.display,
    profile.typographyRoles.body,
    profile.typographyRoles.mono,
  ].join(" ");
  return /(^|\s)_[a-z0-9]{5,}/i.test(corpus);
}

function hasGenericPreviewCopy(preview: string | undefined) {
  if (!preview) return false;
  return /一套可复用的设计系统|应用这套视觉语言|把网站气质转成可以迁移的设计协议/.test(preview);
}

function countTruthy(values: boolean[]) {
  return values.filter(Boolean).length;
}

function modelGate(profile: DesignSystemProfile) {
  const synthesis = profile.synthesis;
  const status = synthesis.status ?? (synthesis.mode === "model" ? "model-success" : "heuristic-only");
  const requiredAndMissing = Boolean(synthesis.required && status !== "model-success");
  let score = 6;
  if (status === "model-success") score = 18;
  if (status === "model-failed") score = 8;
  if (status === "model-skipped") score = 7;
  if (status === "heuristic-only") score = 6;
  const statusOverride = requiredAndMissing ? "fail" : status === "model-success" ? "pass" : "warn";
  return makeGate(
    "ai-synthesis",
    "AI semantic synthesis",
    18,
    requiredAndMissing ? Math.min(score, 4) : score,
    [
      `status: ${status}`,
      `mode: ${synthesis.mode}`,
      `model: ${synthesis.model ?? "not configured"}`,
      synthesis.reason ? `reason: ${synthesis.reason}` : "reason: not recorded",
    ],
    "Configure DESIGN_VAULT_MODEL_BASE_URL and DESIGN_VAULT_MODEL_API_KEY, then set DESIGN_VAULT_REQUIRE_MODEL=1 for production imports.",
    requiredAndMissing,
    statusOverride,
  );
}

export function evaluateDesignQuality({
  evidence,
  meta,
  previews = {},
  profile,
  tokens,
}: {
  evidence: DesignEvidence;
  meta?: Pick<DesignMeta, "sourceHost" | "sourceMode" | "sourceUrl" | "title">;
  previews?: PreviewHtml;
  profile: DesignSystemProfile;
  tokens: DesignTokens;
}): DesignQualityReport {
  const sourceChain = evidence.sourceChain ?? [];
  const primarySource =
    sourceChain.length === 0 ||
    sourceChain.some((entry) => entry.role === "primary") ||
    (sourceChain.length === 1 && sourceChain[0]?.role === "requested" && sourceChain[0]?.url === evidence.sourceUrl);
  const evidenceDepthSignals = countTruthy([
    evidence.headings.length >= 1,
    evidence.colorCandidates.length >= 4,
    evidence.fontCandidates.length >= 1,
    (evidence.sections?.length ?? 0) >= 4,
    (evidence.behaviorSignals?.length ?? 0) >= 2,
    (evidence.responsiveSignals?.length ?? 0) >= 1,
    (evidence.visualCrossCheck?.steps.length ?? 0) >= 2,
    evidence.assetSummary.total >= 2,
    primarySource,
  ]);
  const evidenceGate = makeGate(
    "source-evidence",
    "Source evidence depth",
    14,
    (evidenceDepthSignals / 9) * 14,
    [
      `${evidence.headings.length} heading samples`,
      `${evidence.colorCandidates.length} color candidates`,
      `${evidence.fontCandidates.length} font candidates`,
      `${evidence.sections?.length ?? 0} section samples`,
      `${evidence.behaviorSignals?.length ?? 0} behavior signals`,
      `${evidence.responsiveSignals?.length ?? 0} responsive signals`,
      `${evidence.visualCrossCheck?.steps.length ?? 0} rendered visual journey captures`,
      primarySource ? "primary source resolved or direct source used" : "primary source not resolved",
    ],
    "Capture source topology, rendered scroll/hover journey, behavior, responsive hints, and assets before synthesizing downstream design rules.",
  );

  const aiGate = modelGate(profile);
  const roleSignals = countTruthy([
    /^#[0-9a-f]{6}$/i.test(profile.colorRoles.background),
    /^#[0-9a-f]{6}$/i.test(profile.colorRoles.text),
    /^#[0-9a-f]{6}$/i.test(profile.colorRoles.brandPrimary),
    profile.colorRoles.background.toLowerCase() !== profile.colorRoles.text.toLowerCase(),
    profile.colorRoles.notes.length >= 2,
    profile.typographyRoles.rationale.length >= 2,
    !hasHashFontLeak(tokens, profile),
  ]);
  const roleGate = makeGate(
    "semantic-roles",
    "Semantic token roles",
    12,
    (roleSignals / 7) * 12,
    [
      `background: ${profile.colorRoles.background}`,
      `text: ${profile.colorRoles.text}`,
      `accent: ${profile.colorRoles.brandPrimary}`,
      `display font: ${profile.typographyRoles.display}`,
      hasHashFontLeak(tokens, profile) ? "hash-like font leak detected" : "no hash-like font leak detected",
    ],
    "Assign roles from source context and contrast, not raw CSS frequency or framework variable names.",
    hasHashFontLeak(tokens, profile),
  );

  const specificitySignals = countTruthy([
    !isGenericArchetype(profile.archetype),
    Boolean(profile.visualDna),
    (profile.visualDna?.mustPreserve.length ?? 0) >= 3,
    Boolean(profile.previewStrategy?.renderer),
    (profile.previewStrategy?.layoutDirectives.length ?? 0) >= 3,
    (profile.previewStrategy?.avoidDirectives.length ?? 0) >= 3,
    profile.compositionSignatures.length >= 3,
  ]);
  const specificityGate = makeGate(
    "style-specificity",
    "Style specificity",
    14,
    (specificitySignals / 7) * 14,
    [
      `archetype: ${profile.archetype}`,
      `renderer: ${profile.previewStrategy?.renderer ?? "missing"}`,
      `${profile.compositionSignatures.length} composition signatures`,
      `${profile.visualDna?.mustPreserve.length ?? 0} must-preserve rules`,
    ],
    "Design systems need source-traceable archetypes, layout directives, and anti-patterns; hardcoded renderer specificity is not required.",
    isGenericArchetype(profile.archetype),
  );

  const componentSignals = countTruthy([
    profile.componentSignatures.length >= 3,
    profile.componentSignatures.every((item) => item.traits.length >= 2),
    profile.componentSignatures.some((item) => item.states.length >= 3),
    (profile.componentMotionRecipes?.length ?? 0) >= 1,
    (profile.componentMotionRecipes ?? []).some((item) => item.pptAdapter.length >= 1 && item.choreography.length >= 1),
    profile.interactionModel.states.length >= 3,
    (evidence.stateInventory?.length ?? 0) >= 2,
    profile.interactionModel.motionNotes.length >= 2,
  ]);
  const componentGate = makeGate(
    "components-interaction",
    "Component and interaction contract",
    12,
    (componentSignals / 8) * 12,
    [
      `${profile.componentSignatures.length} component signatures`,
      `${profile.componentMotionRecipes?.length ?? 0} component motion recipes`,
      `${profile.interactionModel.states.length} required interaction states`,
      `${evidence.stateInventory?.length ?? 0} source-derived state inventory items`,
      `${profile.interactionModel.motionNotes.length} motion notes`,
    ],
    "Downstream systems need component traits plus explicit states and motion rules, not only visual adjectives.",
  );

  const renderer = profile.previewStrategy?.renderer;
  const previewSignals = countTruthy([
    Boolean(previews.web),
    Boolean(previews.ppt),
    Boolean(renderer),
    !hasGenericPreviewCopy(previews.web),
    !hasGenericPreviewCopy(previews.ppt),
    renderer === "product-system" || renderer === "custom" || isSpecificRenderer(renderer),
    previews.web ? !/<img\b/i.test(previews.web) || /alt=/.test(previews.web) : false,
  ]);
  const previewGate = makeGate(
    "preview-fidelity",
    "Preview fidelity",
    14,
    (previewSignals / 7) * 14,
    [
      `web preview: ${previews.web ? "present" : "missing"}`,
      `ppt preview: ${previews.ppt ? "present" : "missing"}`,
      `renderer: ${renderer ?? "missing"}`,
      hasGenericPreviewCopy(previews.web) || hasGenericPreviewCopy(previews.ppt) ? "generic preview copy detected" : "no generic preview copy detected",
    ],
    "Preview HTML must demonstrate the source visual grammar and avoid fallback poster/card copy for distinctive sites.",
  );

  const downstreamSignals = countTruthy([
    Boolean(profile.methodology),
    (profile.methodology?.sourceOfTruth.length ?? 0) >= 3,
    (profile.methodology?.abstractionSteps.length ?? 0) >= 4,
    (profile.methodology?.fidelityChecks.length ?? 0) >= 3,
    profile.openSlideGuidance.layoutApproach.length >= 3,
    profile.openSlideGuidance.motionApproach.length >= 1,
    Boolean(profile.presentationStyle),
    (profile.presentationStyle?.narrativeArc.length ?? 0) >= 4,
    (profile.presentationStyle?.slideArchetypes.length ?? 0) >= 5,
    (profile.presentationStyle?.qualityChecks.length ?? 0) >= 5,
    (profile.presentationStyle?.themeRhythm.emphasisCadence.length ?? 0) >= 2,
    Boolean(meta?.sourceUrl ?? evidence.sourceUrl),
  ]);
  const downstreamGate = makeGate(
    "downstream-usability",
    "Downstream usability",
    10,
    (downstreamSignals / 12) * 10,
    [
      `${profile.methodology?.sourceOfTruth.length ?? 0} source-of-truth rules`,
      `${profile.methodology?.abstractionSteps.length ?? 0} abstraction steps`,
      `${profile.methodology?.fidelityChecks.length ?? 0} fidelity checks`,
      `${profile.openSlideGuidance.layoutApproach.length} slide layout rules`,
      `${profile.presentationStyle?.slideArchetypes.length ?? 0} presentation archetypes`,
      `${profile.presentationStyle?.qualityChecks.length ?? 0} presentation quality checks`,
    ],
    "Design.md and open-slide theme must tell another system exactly what to preserve, avoid, verify, and how to sequence title, data, image, single-text, and multi-text presentation previews.",
  );

  const riskSignals = countTruthy([
    profile.antiPatterns.length >= 5,
    profile.accessibilityAndRisks.length >= 3,
    profile.evidenceSummary.length >= 4,
    !profile.antiPatterns.some((item) => /placeholder|lorem/i.test(item)),
    !profile.voiceAndBrand.copyNotes.some((item) => /invent|fake/i.test(item)),
  ]);
  const riskGate = makeGate(
    "risk-controls",
    "Risk and anti-pattern controls",
    8,
    (riskSignals / 5) * 8,
    [
      `${profile.antiPatterns.length} anti-patterns`,
      `${profile.accessibilityAndRisks.length} accessibility/risk notes`,
      `${profile.evidenceSummary.length} evidence summary items`,
    ],
    "A production design system needs explicit anti-patterns and accessibility risks so later generators do not drift.",
  );

  // APCA contrast gate — methodology Ch.2.3 enforcement.
  //
  // Score the actually-used text/bg pairs against the APCA Lc thresholds:
  //   * primary text on default bg                (most weighted)
  //   * primary text on surface-alt (when set)    (medium)
  //   * primary text on surface-deep / inverse on deep when present (medium)
  // Body-copy minimum is |Lc| ≥ 60; anything below that earns a warning
  // and proportionally reduced points. Catches the failure mode where
  // the AI returned `text:#0099ff` on `bg:#000000` (low contrast,
  // wrong call) that we'd otherwise only catch via visual review.
  const contrastChecks: Array<{ label: string; text: string; bg: string; weight: number }> = [
    { label: "text on bg", text: profile.colorRoles.text, bg: profile.colorRoles.background, weight: 6 },
  ];
  if (profile.colorRoles.surfaceAlternate) {
    contrastChecks.push({ label: "text on surface-alt", text: profile.colorRoles.text, bg: profile.colorRoles.surfaceAlternate, weight: 2 });
  }
  if (profile.colorRoles.surfaceDeep) {
    // Inverse role: on a deep surface, primary text usually flips to white-ish
    contrastChecks.push({ label: "inverse text on surface-deep", text: "#ffffff", bg: profile.colorRoles.surfaceDeep, weight: 2 });
  }
  let contrastScore = 0;
  const contrastMaxScore = contrastChecks.reduce((sum, c) => sum + c.weight, 0);
  const contrastDetails: string[] = [];
  let contrastForceFail = false;
  for (const check of contrastChecks) {
    const lc = apcaContrast(check.text, check.bg);
    const abs = Math.abs(lc);
    const tier = apcaTier(lc);
    let earned = 0;
    if (tier === "fluent") earned = check.weight;
    else if (tier === "body") earned = check.weight * 0.85;
    else if (tier === "large-only") earned = check.weight * 0.5;
    else earned = 0;
    contrastScore += earned;
    const arrow = earned === 0 ? "✗" : earned >= check.weight ? "✓" : "△";
    contrastDetails.push(`${arrow} ${check.label} (Lc ${abs.toFixed(1)}, ${tier})`);
    // Hard-fail when the PRIMARY pair tier is "fail" — that's an AI
    // role-assignment error that downstream can't paper over.
    if (check.label === "text on bg" && tier === "fail") contrastForceFail = true;
  }
  const contrastGate = makeGate(
    "apca-contrast",
    "APCA text/background contrast",
    contrastMaxScore,
    contrastScore,
    contrastDetails,
    "Body copy requires APCA |Lc| ≥ 60. Lower scores mean the AI picked text/background colors that won't meet WCAG 3.x readability — usually a role-assignment mistake (e.g. saturated brand color used as background while the actual rendered viewport has it as accent).",
    contrastForceFail,
  );

  const gates = [evidenceGate, aiGate, roleGate, specificityGate, componentGate, previewGate, downstreamGate, riskGate, contrastGate];
  const scoreBeforeCap = gates.reduce((sum, gate) => sum + gate.score, 0);
  const maxScore = gates.reduce((sum, gate) => sum + gate.maxScore, 0);
  const normalized = Math.round((scoreBeforeCap / maxScore) * 100);
  const modelStatus = profile.synthesis.status ?? (profile.synthesis.mode === "model" ? "model-success" : "heuristic-only");
  const cappedScore = modelStatus === "model-success" ? normalized : Math.min(normalized, 89);
  const failed = gates.some((gate) => gate.status === "fail");
  const grade = cappedScore >= 90 && !failed ? "production-9plus" : cappedScore >= 80 && !failed ? "needs-review" : "blocked";
  const summary =
    grade === "production-9plus"
      ? "Passes the 9/10 production gate: source evidence, AI interpretation, preview fidelity, and downstream rules are aligned."
      : modelStatus !== "model-success"
        ? "Below 9/10 because AI model synthesis did not complete; configure the model layer and refresh the record."
        : "Below 9/10 because one or more evidence, preview, or downstream usability gates need review.";

  return {
    schemaVersion: "1.0",
    score: cappedScore,
    threshold: 90,
    grade,
    summary,
    gates,
  };
}
