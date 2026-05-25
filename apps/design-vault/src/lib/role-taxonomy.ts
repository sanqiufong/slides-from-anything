/**
 * Canonical role taxonomy for the W4 token system.
 *
 * The W1 token tier (primitive + semantic) is generic and cross-site, but
 * the `colorRoles.accentPalette[].role` slot we ship from the model is
 * free-form. Each site invents its own vocabulary — noa says
 * "hero-fill / sticky-nav-surface / deep-closing-surface", Linear would
 * say "sidebar-bg / cmdk-overlay", Stripe would say "pricing-emerald".
 *
 * That works visually but makes the generated `--dv-color-*` vars
 * per-site rather than reusable. To get a generalizable design-system
 * abstraction we need a FIXED enum every site maps into.
 *
 * The seven canonical roles below are the load-bearing layout roles a
 * color can play, in the order a viewer encounters them while scrolling:
 *
 *   - hero              first viewport identity surface
 *   - persistent-chrome thin always-visible bar (nav / footer-link strip)
 *   - alt-section       a second large surface that interleaves with bg
 *                       (catalog band, pull-quote interlude)
 *   - deep-section      footer / closing CTA dark band
 *   - accent            small high-saturation marker (CTA dot, swatch, badge)
 *   - muted             desaturated tint used for inactive controls
 *   - decorative        purely-ornamental color (sparkle, gradient stop)
 *
 * Each accentPalette entry now carries BOTH the AI's original free-form
 * `role` (kept as a human description) AND a `canonicalRole` from this
 * enum so downstream renderers can address vars by canonical name no
 * matter which site they came from.
 *
 * The compiler still emits the original slug as a `--dv-color-<slug>` var
 * for backwards compatibility, AND emits a canonical alias
 * `--dv-color-role-<canonical>` so cards generated under v13 can refer to
 * any site's "hero band" with a single name.
 */

export type CanonicalRole =
  | "hero"
  | "persistent-chrome"
  | "alt-section"
  | "deep-section"
  | "accent"
  | "muted"
  | "decorative";

export const CANONICAL_ROLES: readonly CanonicalRole[] = [
  "hero",
  "persistent-chrome",
  "alt-section",
  "deep-section",
  "accent",
  "muted",
  "decorative",
] as const;

/**
 * Synonym → canonical mapping. Sorted from MORE specific to LESS specific
 * because we match by `.includes()` in a single pass. Keys are normalised
 * to lowercase, non-alphanumeric collapsed to single dashes.
 *
 * When the model invents new role names we'll keep extending this map
 * rather than rejecting unknowns — the goal is to *funnel* free-form
 * vocabulary into the canonical 7, not to police the model.
 */
const SYNONYM_TABLE: ReadonlyArray<readonly [needle: string, canonical: CanonicalRole]> = [
  // hero — first viewport identity field
  ["hero-fill", "hero"],
  ["hero-bg", "hero"],
  ["hero-background", "hero"],
  ["hero-surface", "hero"],
  ["first-viewport-fill", "hero"],
  ["first-viewport-bg", "hero"],
  ["splash", "hero"],
  ["landing-fill", "hero"],
  ["above-fold", "hero"],
  ["banner", "hero"],
  ["masthead", "hero"],
  ["hero", "hero"],

  // persistent-chrome — always-visible chrome bars
  ["sticky-nav-surface", "persistent-chrome"],
  ["sticky-header", "persistent-chrome"],
  ["sticky-nav", "persistent-chrome"],
  ["persistent-header", "persistent-chrome"],
  ["persistent-bar", "persistent-chrome"],
  ["nav-surface", "persistent-chrome"],
  ["navbar", "persistent-chrome"],
  ["topbar", "persistent-chrome"],
  ["chrome-bar", "persistent-chrome"],
  ["chrome", "persistent-chrome"],
  ["always-visible", "persistent-chrome"],

  // alt-section — secondary large surface interleaved with bg
  ["pullquote", "alt-section"],
  ["pull-quote-section", "alt-section"],
  ["interstitial-surface", "alt-section"],
  ["interstitial", "alt-section"],
  ["alternate-band", "alt-section"],
  ["section-break", "alt-section"],
  ["section-divider", "alt-section"],
  ["catalog-band", "alt-section"],
  ["secondary-surface", "alt-section"],
  ["secondary-section", "alt-section"],
  ["panel-accent", "alt-section"],
  ["pricing-strip", "alt-section"],
  ["alt-section", "alt-section"],
  ["surface-alt", "alt-section"],
  ["surface-alternate", "alt-section"],

  // deep-section — footer / closing band
  ["footer", "deep-section"],
  ["closing-band", "deep-section"],
  ["closing-cta", "deep-section"],
  ["deep-closing-surface", "deep-section"],
  ["dark-finale", "deep-section"],
  ["final-act", "deep-section"],
  ["surface-deep", "deep-section"],
  ["deep-section", "deep-section"],

  // accent — high-saturation small markers
  ["cta", "accent"],
  ["call-to-action", "accent"],
  ["button-fill", "accent"],
  ["primary-button", "accent"],
  ["active-state", "accent"],
  ["highlight", "accent"],
  ["hover-highlight", "accent"],
  ["badge", "accent"],
  ["marker", "accent"],
  ["dot", "accent"],
  ["pill", "accent"],
  ["link", "accent"],
  ["brand-mark", "accent"],
  ["accent", "accent"],

  // muted — desaturated tint
  ["muted", "muted"],
  ["disabled", "muted"],
  ["placeholder", "muted"],
  ["divider", "muted"],
  ["border-color", "muted"],
  ["rule", "muted"],
  ["secondary-text", "muted"],
  ["tint", "muted"],

  // decorative — ornamental
  ["decorative", "decorative"],
  ["ornament", "decorative"],
  ["sparkle", "decorative"],
  ["gradient-stop", "decorative"],
  ["mesh-color", "decorative"],
  ["confetti", "decorative"],
  ["pattern", "decorative"],
  ["wash", "decorative"],
  ["chart-axis", "decorative"],
];

function normaliseNeedle(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Map a free-form role string to one of the seven canonical roles. Uses
 * substring containment so "oversized-display-type" hits "type" only if
 * we add it explicitly — there's no fuzzy fallback. Returns `undefined`
 * when no synonym matches; the caller decides whether to drop the entry,
 * default to "decorative", or leave canonicalRole empty.
 */
export function toCanonicalRole(rawRole: string | undefined | null): CanonicalRole | undefined {
  if (!rawRole) return undefined;
  const needle = normaliseNeedle(rawRole);
  if (!needle) return undefined;
  // Direct enum hit first (cheap).
  for (const role of CANONICAL_ROLES) {
    if (needle === role) return role;
  }
  // Then synonym lookup. Match exact tokens or substring inclusions
  // (e.g. "hero-fill-band" still maps via "hero-fill").
  for (const [needleKey, canonical] of SYNONYM_TABLE) {
    if (needle === needleKey || needle.includes(needleKey)) return canonical;
  }
  return undefined;
}

/**
 * Slugify a free-form role string into a CSS-safe primitive token key.
 * Used when the AI didn't provide canonical role but its slug still
 * needs to land somewhere in `tokens.primitive.color`. Capped at 24 chars
 * (matches the existing slug rule in synthesis.ts so downstream consumers
 * see the same shape they always did).
 */
export function slugForPrimitive(rawRole: string | undefined, fallback: string): string {
  if (rawRole && rawRole.trim()) {
    const slug = rawRole.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 24).replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return fallback;
}

/**
 * Public describe-list for use in prompts and docs — keeps the enum
 * vocabulary identical between code and model instructions.
 */
export const CANONICAL_ROLE_GUIDE: ReadonlyArray<{ role: CanonicalRole; describe: string }> = [
  { role: "hero", describe: "first viewport identity surface that anchors recognition (large saturated field above fold)" },
  { role: "persistent-chrome", describe: "thin always-visible chrome bar (sticky nav, sticky footer strip, persistent CTA)" },
  { role: "alt-section", describe: "second large surface interleaved with the page background (pull-quote band, catalog interlude)" },
  { role: "deep-section", describe: "deep closing band that caps the scroll (footer, final CTA, dark finale)" },
  { role: "accent", describe: "small high-saturation marker (CTA fill, badge, active dot, link tint)" },
  { role: "muted", describe: "desaturated tint for inactive controls, dividers, secondary text" },
  { role: "decorative", describe: "purely ornamental color (gradient stop, sparkle, pattern wash)" },
];
