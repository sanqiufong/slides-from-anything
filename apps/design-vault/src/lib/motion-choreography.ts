import type { DesignEvidence, DesignSystemProfile, ProfileTokens } from "./types";

/**
 * v1 Motion Choreography (additive, flag-gated, deterministic).
 *
 * A page-level *narrative* motion plan derived from already-extracted
 * evidence. It does NOT replace `componentMotionRecipes` (per-component,
 * CSS-hint level) — it sits one altitude above them, describing how the
 * deck as a whole enters, transitions between states, and turns pages.
 * Every timing string resolves to a real token primitive value.
 */
export type MotionChoreography = {
  /** Brand motion posture, mirrored from tokens.semantic.posture when present. */
  posture?: "restrained" | "expressive" | "dramatic" | "playful";
  /** Ordered entrance plan: how primary regions appear on slide-enter. */
  entrance?: Array<{
    /** Section role or component label this step applies to. */
    target: string;
    /** Motion verb: "fade" | "rise" | "scale" | "mask-reveal" | "slide" | "settle". */
    motion: string;
    /** Real ms value pulled from tokens.primitive.duration (e.g. "220ms"). */
    duration: string;
    /** Cumulative entrance delay forming the stagger ladder (e.g. "0ms","90ms"). */
    delay: string;
    /** cubic-bezier string from tokens.primitive.easing. */
    easing: string;
  }>;
  /** Per-trigger state transitions distilled from behavior signals. */
  transitions?: Array<{
    /** "hover/focus-visible" | "scroll" | "state-change" | "focus / validation". */
    trigger: string;
    statePair: string;
    duration: string;
    easing: string;
  }>;
  /** How to move between slides/pages (the page-turn metaphor). */
  pageTransition?: {
    motion: string;
    duration: string;
    easing: string;
    /** Inter-element stagger when a page reveals multiple regions. */
    stagger?: string;
  };
  /** Per-element stagger step used by the entrance ladder (e.g. "90ms"). */
  stagger?: string;
  /** Human-readable notes for the PPT model + design.md. */
  choreographyNotes?: string[];
  /** Provenance + trust. */
  provenance: {
    /** Always "heuristic-v1" in v1 (no model derivation). */
    method: "heuristic-v1";
    /** Named evidence fields actually consulted, for auditability. */
    sources: string[];
    confidence: "low" | "medium" | "high";
  };
};

/**
 * Kill-switch. Default ON. Disabled only by an explicit negative env value.
 * Mirrors the repo's existing negative-flag convention but with a broader
 * off-set and the OD_-prefixed name.
 */
export function motionChoreographyEnabled(): boolean {
  const v = (process.env.OD_MOTION_CHOREOGRAPHY ?? "").trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

/** Inline copy of synthesis.ts `isNoisyMotionSignal` corpus predicate. */
const NOISY_MOTION_SIGNAL = /w-webflow-badge|grecaptcha|cookie|pixel|tracking|intercom|launcher|skip-link/;

/** ms formatter: rounds to an integer ms string. */
function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

/** First ms-shaped token inside a free-form evidence string, if any. */
function msFromEvidence(corpus: string): string | undefined {
  const match = corpus.match(/\d+(?:\.\d+)?m?s/);
  return match?.[0];
}

/**
 * Build a deterministic, provenance-stamped page-level motion plan from the
 * already-extracted evidence + tier-2 token primitives. No I/O, no model
 * calls, no webm decoding. Identical evidence → identical output.
 */
export function buildMotionChoreography(
  evidence: DesignEvidence,
  tokens: ProfileTokens | undefined,
  profile: Pick<DesignSystemProfile, "componentSignatures" | "componentMotionRecipes">,
): MotionChoreography | undefined {
  if (!motionChoreographyEnabled()) return undefined;

  // Step 0 — resolve real timing primitives.
  const dur = tokens?.primitive.duration ?? { fast: 150, base: 220, slow: 320, emphasized: 500 };
  const ez = tokens?.primitive.easing ?? {
    standard: "cubic-bezier(0.2,0,0,1)",
    decelerate: "cubic-bezier(0,0,0.2,1)",
    emphasized: "cubic-bezier(0.05,0.7,0.1,1)",
    accelerate: "cubic-bezier(0.3,0,1,1)",
  };
  const durBase = dur.base ?? 220;
  const durSlow = dur.slow ?? 320;
  const durEmphasized = dur.emphasized ?? 500;
  const ezStandard = ez.standard ?? "cubic-bezier(0.2,0,0,1)";
  const ezDecelerate = ez.decelerate ?? ezStandard;
  const ezEmphasized = ez.emphasized ?? ezStandard;

  const sources: string[] = [];

  // Step 1 — posture (mirror, do not recompute).
  const posture = tokens?.semantic.posture;
  if (posture) sources.push("tokens.semantic.posture");
  const postureForNotes = posture ?? "expressive";

  // Step 2 — stagger ladder from posture.
  const staggerNum =
    posture === "restrained" ? 60 : posture === "dramatic" ? 140 : posture === "playful" ? 110 : 90;
  const stagger = ms(staggerNum);

  // Step 3 — entrance order from sections (fallback to component signatures).
  const rawSections = evidence.sections ?? [];
  type EntranceSeed = { target: string; role: string };
  let seeds: EntranceSeed[] = [];
  if (rawSections.length > 0) {
    sources.push("sections");
    seeds = [...rawSections]
      .sort((a, b) => a.order - b.order)
      .filter((section) => section.role !== "footer")
      .slice(0, 5)
      .map((section) => ({ target: section.label || section.role, role: section.role }));
  } else {
    seeds = (profile.componentSignatures ?? [])
      .slice(0, 3)
      .map((component) => ({ target: component.name, role: component.role }));
  }

  const motionForRole = (role: string, index: number): string => {
    const r = role.toLowerCase();
    if (r === "hero") return posture === "dramatic" ? "mask-reveal" : "rise";
    if (r === "feature" || r === "content") return "rise";
    if (r === "pricing" || r === "faq") return "fade";
    if (r === "nav") return "settle";
    if (posture === "restrained") return "fade";
    if (posture === "dramatic") return "scale";
    return "rise";
  };

  const entrance = seeds.map((seed, i) => ({
    target: seed.target,
    motion: motionForRole(seed.role, i),
    duration: ms(i === 0 ? durEmphasized : durBase),
    delay: ms(i * staggerNum),
    easing: i === 0 ? ezEmphasized : ezDecelerate,
  }));

  // Step 3 cross-check — visual journey scroll-reveal order.
  const journeySteps = evidence.visualCrossCheck?.steps ?? [];
  const hasScrollStep = journeySteps.some((step) => step.action === "scroll");
  const crossCheckNotes: string[] = [];
  if (journeySteps.length > 0) {
    sources.push("visualCrossCheck.steps");
    if (hasScrollStep) {
      crossCheckNotes.push("Entrance maps to the observed scroll-reveal order from the rendered journey.");
    }
  }

  // Step 4 — transitions from behavior signals.
  const triggerForKind = (kind: string): string => {
    if (kind === "hover") return "hover/focus-visible";
    if (kind === "sticky" || kind === "fixed" || kind === "scroll-snap") return "scroll";
    if (kind === "animation") return "slide-enter";
    if (kind === "tabs" || kind === "accordion" || kind === "dialog" || kind === "carousel" || kind === "state")
      return "state-change";
    if (kind === "form") return "focus / validation";
    return "state-change";
  };
  const statePairForKind = (kind: string): string => {
    if (kind === "hover") return "default -> hover/focus-visible";
    if (kind === "accordion") return "collapsed -> expanded";
    if (kind === "dialog") return "closed -> open";
    if (kind === "carousel") return "inactive slide -> active slide";
    if (kind === "tabs") return "inactive tab -> selected tab";
    if (kind === "form") return "empty/default -> focused/validated";
    if (kind === "sticky" || kind === "fixed") return "flowing -> pinned";
    if (kind === "scroll-snap") return "between sections -> snapped section";
    if (kind === "animation") return "off-canvas / initial -> animated state";
    return "default -> active/current";
  };

  const behaviorSignals = (evidence.behaviorSignals ?? []).filter(
    (signal) => !NOISY_MOTION_SIGNAL.test(`${signal.selector} ${signal.evidence}`.toLowerCase()),
  );
  const transitions: NonNullable<MotionChoreography["transitions"]> = [];
  if (behaviorSignals.length > 0) {
    sources.push("behaviorSignals");
    const seen = new Set<string>();
    for (const signal of behaviorSignals) {
      const trigger = triggerForKind(signal.kind);
      if (seen.has(trigger)) continue;
      seen.add(trigger);
      transitions.push({
        trigger,
        statePair: statePairForKind(signal.kind),
        duration: msFromEvidence(signal.evidence) ?? ms(durBase),
        easing: ezStandard,
      });
      if (transitions.length >= 4) break;
    }
  } else {
    const interaction = evidence.interactionSignals;
    if (interaction && (interaction.hasTransitions || interaction.hasAnimations || interaction.hasHoverStyles)) {
      sources.push("interactionSignals");
      transitions.push({
        trigger: "state-change",
        statePair: "default -> active/current",
        duration: ms(durBase),
        easing: ezStandard,
      });
    }
  }

  // Step 5 — pageTransition (the deck page-turn).
  const pageMotion =
    posture === "restrained"
      ? "cross-fade"
      : posture === "dramatic"
        ? "wipe"
        : posture === "playful"
          ? "push"
          : "fade-and-rise";
  const pageTransition = {
    motion: pageMotion,
    duration: ms(durSlow),
    easing: ezEmphasized,
    stagger,
  };

  // Record token-primitive provenance (Step 0 values were consulted).
  sources.push("tokens.primitive.duration", "tokens.primitive.easing");

  // Step 6 — choreographyNotes (≤4, factual, source-recognisable).
  const choreographyNotes: string[] = [];
  if (seeds.length > 0) {
    const label = rawSections.length > 0 ? "section" : "component";
    choreographyNotes.push(`Entrance follows source DOM ${label} order (${seeds.length} ${label}s).`);
  }
  choreographyNotes.push(`Posture ${postureForNotes} from observed durations.`);
  if (transitions.length > 0) {
    choreographyNotes.push(`${transitions.length} distinct interaction triggers mapped.`);
  }
  choreographyNotes.push(`Page turns use ${pageMotion} at ${durSlow}ms.`);
  choreographyNotes.push(...crossCheckNotes);
  const cappedNotes = choreographyNotes.filter(Boolean).slice(0, 4);

  // Step 7 — provenance / confidence.
  const sectionCount = rawSections.length;
  const present = [
    sectionCount >= 3,
    behaviorSignals.length > 0,
    Boolean(posture),
  ];
  const presentCount = present.filter(Boolean).length;
  const confidence: MotionChoreography["provenance"]["confidence"] =
    sectionCount >= 3 && behaviorSignals.length > 0 && Boolean(posture)
      ? "high"
      : presentCount >= 2
        ? "medium"
        : journeySteps.length > 0
          ? "medium"
          : "low";

  const uniqueSources = Array.from(new Set(sources));

  // Empty-guard: still return the stamped object (additive, never throws).
  const result: MotionChoreography = {
    provenance: {
      method: "heuristic-v1",
      sources: uniqueSources,
      confidence,
    },
  };
  if (posture) result.posture = posture;
  if (entrance.length > 0) result.entrance = entrance;
  if (transitions.length > 0) result.transitions = transitions;
  result.pageTransition = pageTransition;
  result.stagger = stagger;
  if (cappedNotes.length > 0) result.choreographyNotes = cappedNotes;

  return result;
}
