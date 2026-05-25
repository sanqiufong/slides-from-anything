import type {
  DesignSystemProfile,
  ProfileTokens,
  ProfileTokensPrimitive,
  ProfileTokensSemantic,
} from "./types";
import { slugForPrimitive, toCanonicalRole } from "./role-taxonomy";

/**
 * Inline migrator — same shape as synthesis.ts/migrateLegacyProfileTokens
 * but lives here so the compiler is self-contained and doesn't pull
 * synthesis (and its model dependencies) into preview render paths.
 * Profiles serialised before W1.1 have no `tokens` field; this fills
 * one in deterministically from legacy colorRoles + typographyRoles.
 */
function legacyMigrate(profile: DesignSystemProfile): ProfileTokens {
  const cr = profile.colorRoles;
  const color: Record<string, string> = {};
  if (cr.brandPrimary) color["brand"] = cr.brandPrimary;
  if (cr.brandSecondary) color["brand-secondary"] = cr.brandSecondary;
  if (cr.background) color["bg"] = cr.background;
  if (cr.text) color["text"] = cr.text;
  if (cr.surfaceAlternate) color["surface-alt"] = cr.surfaceAlternate;
  if (cr.surfaceDeep) color["surface-deep"] = cr.surfaceDeep;
  const palette = cr.accentPalette;
  if (palette) {
    // W4.1 alias: emit `role-<canonical>` var alongside the free-form
    // slug so previews built under v13 can use cross-site canonical
    // names while legacy previews continue to resolve their original
    // slug. Mirrors synthesis.ts/migrateLegacyProfileTokens.
    const canonicalSeen = new Set<string>();
    for (let i = 0; i < palette.length; i++) {
      const entry = palette[i];
      if (!entry?.hex) continue;
      const slug = slugForPrimitive(entry.role, `accent-${i + 1}`);
      color[slug] = entry.hex;
      const canonical = entry.canonicalRole ?? toCanonicalRole(entry.role);
      if (canonical && !canonicalSeen.has(canonical)) {
        color[`role-${canonical}`] = entry.hex;
        canonicalSeen.add(canonical);
      }
    }
  }
  return {
    primitive: {
      color,
      space: { "0": "0px", "1": "4px", "2": "8px", "3": "12px", "4": "16px", "6": "24px", "8": "32px", "12": "48px", "16": "64px" },
      radius: { xs: "2px", sm: "4px", md: "8px", lg: "12px", xl: "16px", full: "9999px" },
      fontSize: { xs: "12px", sm: "14px", base: "16px", md: "18px", lg: "22px", xl: "28px", "2xl": "36px", "3xl": "48px" },
      duration: { fast: 150, base: 220, slow: 320, emphasized: 500 },
      easing: {
        standard: "cubic-bezier(0.2, 0, 0, 1)",
        accelerate: "cubic-bezier(0.3, 0, 1, 1)",
        decelerate: "cubic-bezier(0, 0, 0.2, 1)",
        emphasized: "cubic-bezier(0.05, 0.7, 0.1, 1)",
      },
    },
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
      radius: { button: "sm", card: "lg", modal: "xl", avatar: "full" },
      motion: { tap: "fast", reveal: "base", emphasized: "emphasized" },
    },
  };
}

/**
 * Token-stylesheet compiler.
 *
 * Turns a `DesignSystemProfile.tokens` bundle into a self-contained
 * `<style>` block that any preview HTML can include verbatim. The
 * output is two things stacked:
 *
 *   1. `:root { --dv-<key>: <value>; … }` — every primitive token
 *      exposed as a CSS custom property. Semantic tokens become a
 *      second tier of vars that resolve to primitives via `var(...)`
 *      indirection.
 *
 *   2. A small "DV utility class set" — about thirty Tailwind-style
 *      classes (`.dv-bg`, `.dv-text-primary`, `.dv-rounded-card`,
 *      `.dv-motion-tap`, …) that map to the semantic vars. AI-generated
 *      preview HTML (card-preview.ts in W1.4) is constrained to ONLY
 *      use these classes; it cannot emit raw hex / px / ms.
 *
 * No external dependencies. No DOM. Pure string output, safe to inline
 * into any iframe.
 *
 * Design contract:
 *   * Primitive keys are name-mangled to be CSS-safe (`brand` →
 *     `--dv-color-brand`).
 *   * Semantic vars POINT AT primitive vars via `var()` chains so the
 *     theme dial is a single name swap.
 *   * When a primitive key is missing (e.g. evidence didn't produce
 *     a `surface-deep`), the semantic var falls back gracefully via
 *     CSS `var(--missing, fallback)` syntax — the consumer doesn't
 *     have to null-check.
 */

function cssSafeKey(key: string): string {
  return key.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
}

function primitiveBlock(primitive: ProfileTokensPrimitive): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(primitive.color)) {
    lines.push(`  --dv-color-${cssSafeKey(k)}: ${v};`);
  }
  for (const [k, v] of Object.entries(primitive.space)) {
    lines.push(`  --dv-space-${cssSafeKey(k)}: ${v};`);
  }
  for (const [k, v] of Object.entries(primitive.radius)) {
    lines.push(`  --dv-radius-${cssSafeKey(k)}: ${v};`);
  }
  for (const [k, v] of Object.entries(primitive.fontSize)) {
    lines.push(`  --dv-font-${cssSafeKey(k)}: ${v};`);
  }
  for (const [k, v] of Object.entries(primitive.duration)) {
    lines.push(`  --dv-duration-${cssSafeKey(k)}: ${v}ms;`);
  }
  for (const [k, v] of Object.entries(primitive.easing)) {
    lines.push(`  --dv-easing-${cssSafeKey(k)}: ${v};`);
  }
  return lines.join("\n");
}

function semanticBlock(
  semantic: ProfileTokensSemantic,
  primitive: ProfileTokensPrimitive,
): string {
  // Each semantic var resolves to a primitive var by key indirection.
  // We use the CSS `var(--missing, fallback)` form so a missing
  // primitive (e.g. no surface-alt observed) doesn't break the chain.
  const colorVar = (key: string | undefined, fallback: string) =>
    key && primitive.color[key] ? `var(--dv-color-${cssSafeKey(key)})` : fallback;
  const radiusVar = (key: string | undefined, fallback: string) =>
    key && primitive.radius[key] ? `var(--dv-radius-${cssSafeKey(key)})` : fallback;
  const motionVar = (key: string | undefined, fallback: string) =>
    key && primitive.duration[key] !== undefined
      ? `var(--dv-duration-${cssSafeKey(key)})`
      : fallback;

  return [
    `  /* semantic bg */`,
    `  --dv-bg: ${colorVar(semantic.bg.default, "#ffffff")};`,
    `  --dv-bg-alt: ${colorVar(semantic.bg.alt, "var(--dv-bg)")};`,
    `  --dv-bg-deep: ${colorVar(semantic.bg.deep, "var(--dv-bg)")};`,
    `  /* semantic text */`,
    `  --dv-text-primary: ${colorVar(semantic.text.primary, "#000000")};`,
    `  --dv-text-muted: ${colorVar(semantic.text.muted, "color-mix(in srgb, var(--dv-text-primary) 60%, transparent)")};`,
    `  --dv-text-inverse: ${colorVar(semantic.text.inverse, "var(--dv-bg)")};`,
    `  /* semantic accent */`,
    `  --dv-accent: ${colorVar(semantic.accent.primary, "#000000")};`,
    `  --dv-accent-secondary: ${colorVar(semantic.accent.secondary, "var(--dv-accent)")};`,
    `  /* semantic radius */`,
    `  --dv-radius-button: ${radiusVar(semantic.radius.button, "4px")};`,
    `  --dv-radius-card: ${radiusVar(semantic.radius.card, "12px")};`,
    `  --dv-radius-modal: ${radiusVar(semantic.radius.modal, "var(--dv-radius-card)")};`,
    `  --dv-radius-avatar: ${radiusVar(semantic.radius.avatar, "9999px")};`,
    `  /* semantic motion */`,
    `  --dv-motion-tap: ${motionVar(semantic.motion.tap, "150ms")};`,
    `  --dv-motion-reveal: ${motionVar(semantic.motion.reveal, "220ms")};`,
    `  --dv-motion-emphasized: ${motionVar(semantic.motion.emphasized, "500ms")};`,
    `  --dv-ease-standard: var(--dv-easing-standard, cubic-bezier(0.2, 0, 0, 1));`,
    `  --dv-ease-emphasized: var(--dv-easing-emphasized, cubic-bezier(0.05, 0.7, 0.1, 1));`,
  ].join("\n");
}

/**
 * Small but expressive utility class set. AI prompts in card-preview /
 * preview rendering should constrain themselves to ONLY these classes.
 * That single discipline is what lets us swap themes without rewriting
 * the AI output.
 *
 * Naming: `.dv-` prefix so they can never clash with anything the
 * AI hallucinates from a memory of Tailwind / Bootstrap. Short names
 * so prompt-generated HTML stays small.
 */
const DV_UTILITY_RULES = `
.dv-bg { background-color: var(--dv-bg); }
.dv-bg-alt { background-color: var(--dv-bg-alt); }
.dv-bg-deep { background-color: var(--dv-bg-deep); }
.dv-bg-accent { background-color: var(--dv-accent); }
.dv-bg-accent-secondary { background-color: var(--dv-accent-secondary); }

.dv-text { color: var(--dv-text-primary); }
.dv-text-muted { color: var(--dv-text-muted); }
.dv-text-inverse { color: var(--dv-text-inverse); }
.dv-text-accent { color: var(--dv-accent); }

.dv-rounded-button { border-radius: var(--dv-radius-button); }
.dv-rounded-card { border-radius: var(--dv-radius-card); }
.dv-rounded-modal { border-radius: var(--dv-radius-modal); }
.dv-rounded-avatar { border-radius: var(--dv-radius-avatar); }

/* Nested-radius helper: child radius = parent radius - padding, per the
   "concentric topology" rule from the methodology Ch.2.1. Consumer sets
   --p (its padding) and --r (parent radius); we compute the right inner. */
.dv-rounded-inner { border-radius: calc(var(--r, 12px) - var(--p, 8px)); }

.dv-motion-tap { transition: all var(--dv-motion-tap) var(--dv-ease-standard); }
.dv-motion-reveal { transition: all var(--dv-motion-reveal) var(--dv-ease-standard); }
.dv-motion-emphasized { transition: all var(--dv-motion-emphasized) var(--dv-ease-emphasized); }

.dv-font-display { font-family: var(--dv-font-display, system-ui, sans-serif); }
.dv-font-body { font-family: var(--dv-font-body, system-ui, sans-serif); }
.dv-font-mono { font-family: var(--dv-font-mono, ui-monospace, monospace); }

.dv-text-xs { font-size: var(--dv-font-xs, 12px); }
.dv-text-sm { font-size: var(--dv-font-sm, 14px); }
.dv-text-base { font-size: var(--dv-font-base, 16px); }
.dv-text-md { font-size: var(--dv-font-md, 18px); }
.dv-text-lg { font-size: var(--dv-font-lg, 22px); }
.dv-text-xl { font-size: var(--dv-font-xl, 28px); }
.dv-text-2xl { font-size: var(--dv-font-2xl, 36px); }
.dv-text-3xl { font-size: var(--dv-font-3xl, 48px); }
`.trim();

function fontFamilyVars(profile: DesignSystemProfile): string {
  // Map typography roles to font vars consumed by .dv-font-display etc.
  const display = profile.typographyRoles.display || "system-ui";
  const body = profile.typographyRoles.body || "system-ui";
  const mono = profile.typographyRoles.mono || "ui-monospace";
  // Wrap in quotes when the value contains a space and isn't already quoted.
  const quote = (v: string) => (v.includes(" ") && !v.includes('"') ? `"${v}"` : v);
  return [
    `  --dv-font-display: ${quote(display)}, system-ui, sans-serif;`,
    `  --dv-font-body: ${quote(body)}, system-ui, sans-serif;`,
    `  --dv-font-mono: ${quote(mono)}, ui-monospace, monospace;`,
  ].join("\n");
}

/**
 * Public entry point: compile a profile into a self-contained
 * `<style>…</style>` block ready to inline into preview HTML.
 *
 * Output structure:
 *   <style>
 *     :root {
 *       --dv-color-brand: …;        (primitive — observed values)
 *       --dv-color-bg: …;
 *       --dv-radius-md: …;
 *       …
 *       --dv-bg: var(--dv-color-bg); (semantic — points at primitives)
 *       --dv-text-primary: …;
 *       …
 *       --dv-font-display: …, system-ui, sans-serif;
 *     }
 *     .dv-bg { background-color: var(--dv-bg); }
 *     .dv-rounded-card { … }
 *     …
 *   </style>
 */
export function compileTokenStylesheet(profile: DesignSystemProfile): string {
  // Profiles serialised before W1.1 don't carry `tokens`. Migrate lazily
  // so every render path through this compiler always gets the full
  // two-tier variable set — no separate `tokens.json` regeneration step
  // required on the 60+ existing designs.
  const baseTokens = profile.tokens ?? legacyMigrate(profile);
  const tokens = enrichWithCanonicalRoleAliases(baseTokens, profile);
  const rootBlock = [
    primitiveBlock(tokens.primitive),
    semanticBlock(tokens.semantic, tokens.primitive),
    fontFamilyVars(profile),
  ].join("\n");
  return `<style>\n:root {\n${rootBlock}\n}\n${DV_UTILITY_RULES}\n</style>`;
}

/**
 * W4.1 enrichment: walk `profile.colorRoles.accentPalette` plus
 * `surfaceAlternate / surfaceDeep` and inject `role-<canonical>: hex`
 * entries into `primitive.color` if the canonical role isn't already
 * represented. Works whether `tokens` came from the AI (v12+ profiles)
 * or from `legacyMigrate` (pre-W1.1 profiles) so canonical aliases are
 * available to every preview path regardless of profile age.
 *
 * Idempotent: re-running on already-enriched tokens is a no-op (the
 * `Set` of seen canonical roles prevents duplicate work).
 */
function enrichWithCanonicalRoleAliases(
  tokens: ProfileTokens,
  profile: DesignSystemProfile,
): ProfileTokens {
  const color = { ...tokens.primitive.color };
  const seen = new Set<string>();
  // Mark canonical roles already represented as a `role-<canonical>` key
  // so we don't overwrite a higher-priority binding with a lower one.
  for (const key of Object.keys(color)) {
    if (key.startsWith("role-")) seen.add(key.slice("role-".length));
  }
  const palette = profile.colorRoles.accentPalette;
  if (palette) {
    for (const entry of palette) {
      if (!entry?.hex) continue;
      const canonical = entry.canonicalRole ?? toCanonicalRole(entry.role);
      if (canonical && !seen.has(canonical)) {
        color[`role-${canonical}`] = entry.hex;
        seen.add(canonical);
      }
    }
  }
  // Promote surfaceAlternate / surfaceDeep to canonical-role aliases so
  // the AI's first-class surface picks are addressable as
  // `--dv-color-role-alt-section` / `--dv-color-role-deep-section` —
  // these two are the most cross-site stable canonical roles.
  if (profile.colorRoles.surfaceAlternate && !seen.has("alt-section")) {
    color["role-alt-section"] = profile.colorRoles.surfaceAlternate;
    seen.add("alt-section");
  }
  if (profile.colorRoles.surfaceDeep && !seen.has("deep-section")) {
    color["role-deep-section"] = profile.colorRoles.surfaceDeep;
    seen.add("deep-section");
  }
  // Accent and hero fall back to brand primary / background respectively
  // when no palette entry claimed them — keeps the canonical-role var
  // set complete enough for cross-site templates to lean on.
  if (!seen.has("accent") && profile.colorRoles.brandPrimary) {
    color["role-accent"] = profile.colorRoles.brandPrimary;
    seen.add("accent");
  }
  return {
    ...tokens,
    primitive: { ...tokens.primitive, color },
  };
}

/**
 * Lighter variant for cases where only the `:root { … }` block is wanted
 * (no utility classes, no <style> tag). Used by renderers that already
 * have their own stylesheet and just want the variables.
 */
export function compileTokenVariables(profile: DesignSystemProfile): string {
  const tokens = profile.tokens ?? legacyMigrate(profile);
  return [
    `:root {`,
    primitiveBlock(tokens.primitive),
    semanticBlock(tokens.semantic, tokens.primitive),
    fontFamilyVars(profile),
    `}`,
  ].join("\n");
}
