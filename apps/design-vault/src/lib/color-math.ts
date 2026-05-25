/**
 * Color-math utilities for Design Vault.
 *
 * Implements two pieces of the methodology Ch.2.3:
 *
 * 1. **sRGB ↔ Oklch conversion** (Björn Ottosson, 2020). Lets us reason
 *    about color in a perceptually uniform space instead of HSL, where
 *    "equal lightness" actually looks equal across hues. Used for
 *    perceptual distance + future palette derivation.
 *
 * 2. **APCA contrast** (Andrew Somers' Accessible Perceptual Contrast
 *    Algorithm, W3C draft). Replaces WCAG 2.x's simple luminance ratio
 *    with a perceptually-tuned metric that correctly handles thin /
 *    bold text and is the basis for WCAG 3.x. We use only the FORWARD
 *    contrast direction (text-on-background score); reverse-APCA
 *    palette derivation is a separate W2.3 commit if we choose to do
 *    it.
 *
 * All math is pure functions. No dependencies on DOM, no runtime
 * dependencies on `apca-w3` or similar — the formulas are short enough
 * to inline and easier to maintain. Source: the public W3C APCA Look-up
 * Table (Lc-W3-G-4g-Self.csv) plus Ottosson's Oklab post.
 */

export type Rgb = { r: number; g: number; b: number };
export type Oklch = { l: number; c: number; h: number };

/* -------------------------------------------------------------------- */
/*  Hex / RGB parsing                                                   */
/* -------------------------------------------------------------------- */

/**
 * Parse a CSS hex color (#rgb, #rgba, #rrggbb, #rrggbbaa) into linear
 * 0..1 RGB triples. Returns null for malformed input — callers should
 * treat that as "skip this color".
 */
export function parseHex(hex: string): Rgb | null {
  const value = hex.trim().replace(/^#/, "");
  if (![3, 4, 6, 8].includes(value.length)) return null;
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  const expand = (s: string) =>
    s.length === 3 || s.length === 4
      ? s.split("").map((c) => parseInt(c + c, 16))
      : (s.match(/.{2}/g) ?? []).map((part) => parseInt(part, 16));
  const parts = expand(value);
  if (parts.length < 3) return null;
  return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255 };
}

/* -------------------------------------------------------------------- */
/*  sRGB ↔ Linear ↔ Oklch                                                */
/* -------------------------------------------------------------------- */

/** sRGB component (0..1, gamma-encoded) → linear-light. */
function sRgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Linear-light component (0..1) → sRGB (gamma-encoded). */
function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/**
 * sRGB (0..1, gamma-encoded) → Oklch. Two-stage transform: linearise →
 * Oklab via the LMS basis Ottosson published → convert (a, b) to polar
 * (c, h). Output `l` is 0..1, `c` is 0..~0.4 in sRGB gamut, `h` is
 * 0..360.
 */
export function srgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = sRgbToLinear(r);
  const lg = sRgbToLinear(g);
  const lb = sRgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const oklab_l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const oklab_a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const oklab_b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(oklab_a * oklab_a + oklab_b * oklab_b);
  let h = (Math.atan2(oklab_b, oklab_a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: oklab_l, c, h };
}

/** Oklch → sRGB (0..1, gamma-encoded). Inverse of `srgbToOklch`. */
export function oklchToSrgb({ l, c, h }: Oklch): Rgb {
  const hRad = (h * Math.PI) / 180;
  const oklab_l = l;
  const oklab_a = c * Math.cos(hRad);
  const oklab_b = c * Math.sin(hRad);
  const l_ = oklab_l + 0.3963377774 * oklab_a + 0.2158037573 * oklab_b;
  const m_ = oklab_l - 0.1055613458 * oklab_a - 0.0638541728 * oklab_b;
  const s_ = oklab_l - 0.0894841775 * oklab_a - 1.291485548 * oklab_b;
  const lr_lin = l_ * l_ * l_;
  const lg_lin = m_ * m_ * m_;
  const lb_lin = s_ * s_ * s_;
  const lr = 4.0767416621 * lr_lin - 3.3077115913 * lg_lin + 0.2309699292 * lb_lin;
  const lg = -1.2684380046 * lr_lin + 2.6097574011 * lg_lin - 0.3413193965 * lb_lin;
  const lb = -0.0041960863 * lr_lin - 0.7034186147 * lg_lin + 1.707614701 * lb_lin;
  return {
    r: Math.max(0, Math.min(1, linearToSrgb(lr))),
    g: Math.max(0, Math.min(1, linearToSrgb(lg))),
    b: Math.max(0, Math.min(1, linearToSrgb(lb))),
  };
}

/** Perceptual distance between two hex colors in Oklab (sqrt of squared L+a+b deltas). */
export function perceptualDistanceHex(aHex: string, bHex: string): number | null {
  const a = parseHex(aHex);
  const b = parseHex(bHex);
  if (!a || !b) return null;
  const oa = srgbToOklch(a);
  const ob = srgbToOklch(b);
  const ha = (oa.h * Math.PI) / 180;
  const hb = (ob.h * Math.PI) / 180;
  const ax = oa.c * Math.cos(ha);
  const ay = oa.c * Math.sin(ha);
  const bx = ob.c * Math.cos(hb);
  const by = ob.c * Math.sin(hb);
  const dl = oa.l - ob.l;
  const da = ax - bx;
  const db = ay - by;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/* -------------------------------------------------------------------- */
/*  APCA contrast                                                       */
/* -------------------------------------------------------------------- */

// APCA constants from the public W3C draft / `apca-w3` reference impl.
const MAIN_TRC = 2.4;
const NORM_BG = 0.56;
const NORM_TXT = 0.57;
const REV_TXT = 0.62;
const REV_BG = 0.65;
const BLK_THRS = 0.022;
const BLK_CLMP = 1.414;
const DELTA_Y_MIN = 0.0005;
const SCALE_BOW = 1.14;
const SCALE_WOB = 1.14;
const LO_BOW_THRESH = 0.035991;
const LO_WOB_THRESH = 0.035991;
const LO_BOW_FACTOR = 27.7847239587675;
const LO_WOB_FACTOR = 27.7847239587675;

function sRgbToLuminance({ r, g, b }: Rgb): number {
  // APCA uses a power-curve transform, not the simple sRGB→linear pipeline.
  const tr = Math.pow(r, MAIN_TRC);
  const tg = Math.pow(g, MAIN_TRC);
  const tb = Math.pow(b, MAIN_TRC);
  // CIE Y weights, then clamp dark values per APCA spec to avoid
  // perceptual cliffs at near-black.
  let Y = 0.2126729 * tr + 0.7151522 * tg + 0.072175 * tb;
  if (Y < BLK_THRS) Y = Y + Math.pow(BLK_THRS - Y, BLK_CLMP);
  return Y;
}

/**
 * APCA Lc score (text on background). Returns a signed contrast number
 * roughly in -108..+106. Positive = dark text on light bg
 * (black-on-white). Negative = light text on dark bg (white-on-black).
 * For accessibility: |Lc| ≥ 60 is body-copy worthy, ≥ 75 is
 * large-headline worthy. |Lc| ≥ 90 is "fluent reading" target.
 *
 * Both inputs are CSS hex strings. Returns 0 if either is unparseable.
 */
export function apcaContrast(textHex: string, bgHex: string): number {
  const text = parseHex(textHex);
  const bg = parseHex(bgHex);
  if (!text || !bg) return 0;
  const yText = sRgbToLuminance(text);
  const yBg = sRgbToLuminance(bg);
  let SAPC = 0;
  if (Math.abs(yBg - yText) < DELTA_Y_MIN) return 0;
  if (yBg > yText) {
    SAPC = (Math.pow(yBg, NORM_BG) - Math.pow(yText, NORM_TXT)) * SCALE_BOW;
    if (SAPC < LO_BOW_THRESH) {
      if (SAPC < 0) return 0;
      SAPC -= SAPC * LO_BOW_FACTOR * LO_BOW_THRESH;
    } else {
      SAPC -= 0.027;
    }
  } else {
    SAPC = (Math.pow(yBg, NORM_TXT) - Math.pow(yText, NORM_BG)) * SCALE_WOB;
    if (SAPC > -LO_WOB_THRESH) {
      if (SAPC > 0) return 0;
      SAPC -= SAPC * LO_WOB_FACTOR * LO_WOB_THRESH;
    } else {
      SAPC += 0.027;
    }
  }
  return SAPC * 100;
}

/**
 * Convenience: classify an APCA absolute score into a rough usability
 * tier. Mirrors Adam Argyle's published guidance for picking a tier
 * based on the largest text class that will appear on the pair.
 */
export function apcaTier(lc: number): "fail" | "large-only" | "body" | "fluent" {
  const a = Math.abs(lc);
  if (a < 45) return "fail";
  if (a < 60) return "large-only";
  if (a < 75) return "body";
  return "fluent";
}
