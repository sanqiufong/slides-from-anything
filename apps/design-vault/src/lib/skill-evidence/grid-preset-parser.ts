/**
 * O7 — Grid preset parser.
 *
 * Per the AI-aesthetic-engineering methodology (§1.4 传空间关系，不传定位指令),
 * grid layouts should be FIXED VOCABULARY. Each information relationship
 * (主次 / 对等 / 矩阵) maps to one and only one predefined grid class with
 * predefined column ratios, gap, and alignment. AI's job is "select from
 * these grid classes", not "write grid-template-columns".
 *
 * This parser scans the upstream template CSS for top-level grid class
 * definitions and surfaces them as a closed option set the downstream
 * renderer prompt can enforce.
 *
 * Generic across guizang's `.grid-2-7-5 / .grid-3-3 / .grid-6` style,
 * Swiss's `.swiss-img-split / .grid-12` style, or any CSS file that
 * documents page-level grid containers as named classes.
 *
 * Heuristics:
 * - Only single-class selectors (`.foo`), not descendant rules (`.foo .bar`)
 *   or pseudo-states (`.foo:hover`)
 * - Body must declare `display:grid` AND `grid-template-columns` so we
 *   ignore minor responsive overrides like `@media{.foo{grid-template-columns:1fr}}`
 * - `@media` blocks are stripped before matching so responsive overrides
 *   don't pollute the canonical preset list
 */

export type ParsedGridPreset = {
  /** CSS class name (without leading dot). */
  className: string;
  /** Raw grid-template-columns declaration value. */
  columns: string;
  /** Raw grid-template-rows declaration value, if present. */
  rows?: string;
  /** Raw gap declaration value, if present. */
  gap?: string;
  /** Raw align-items declaration value, if present. */
  alignItems?: string;
  /** Raw padding declaration value, if present. */
  padding?: string;
  /** Whether the rule sets flex:1 (signals "takes remaining frame height"). */
  fillsFrame: boolean;
  /** Human-readable column ratio summary, e.g. "7:5", "1:1", "3×2 matrix", "3 equal". */
  ratio: string;
  /** Short use description derived from class name + columns. */
  role: string;
};

/**
 * Drop all `@media (...) { ... }` blocks (and similar at-rules with
 * nested blocks) from the CSS so the rule scan only sees canonical
 * top-level definitions. Brace-matched walker — handles nested groups
 * inside @media.
 */
function stripAtMediaBlocks(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    // Look for "@media", "@supports", "@container" at this position
    const atMatch = css.slice(i).match(/^@(?:media|supports|container)\b[^{]*\{/);
    if (atMatch) {
      // Skip the at-rule header, then find the matching close brace
      let depth = 0;
      let j = i + atMatch[0].length - 1; // points at the opening {
      depth = 1;
      j++;
      while (j < css.length && depth > 0) {
        const ch = css[j];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        j++;
      }
      // Skip everything from @media to its closing brace
      i = j;
      continue;
    }
    out += css[i];
    i++;
  }
  return out;
}

/** Remove /* ... *​/ comments. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * A "single-class" selector matches `.className` with no descendant
 * combinator, pseudo, attribute, or chained selector. We allow the
 * selector to be one of a comma-separated group only if EVERY entry
 * in the group is a single-class selector — in that case we yield
 * one grid preset per entry.
 */
function selectorIsSingleClass(selector: string): boolean {
  const trimmed = selector.trim();
  // Reject if it has spaces (descendant), >, +, ~, :, [, # or chained .
  // We do this by checking it starts with `.` and the rest is class-name chars.
  return /^\.[a-zA-Z][\w-]*$/.test(trimmed);
}

function splitGroupedSelector(selector: string): string[] {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse a single rule body into a key→value declaration map.
 */
function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const key = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Convert raw `grid-template-columns` (e.g. "7fr 5fr", "repeat(3,1fr)",
 * "1fr 2fr 1fr", "55fr 45fr") to a short human ratio string.
 */
function summarizeColumns(columns: string, rows?: string): string {
  const trimmed = columns.trim();

  // repeat(N, X) — N equal columns
  const repeatMatch = trimmed.match(/^repeat\(\s*(\d+)\s*,\s*([^)]+)\)$/i);
  if (repeatMatch) {
    const n = Number(repeatMatch[1]);
    // If rows is also repeat(M, ...), express as N×M matrix
    if (rows) {
      const rowsRepeat = rows.trim().match(/^repeat\(\s*(\d+)\s*,/i);
      if (rowsRepeat) {
        return `${n}×${rowsRepeat[1]} matrix`;
      }
    }
    return `${n} equal columns`;
  }

  // Mixed fr units — extract integers, preserve raw ratio.
  // We deliberately do NOT GCD-simplify: when the class name encodes
  // the ratio (e.g. .grid-2-8-4), the raw "8:4" matches the naming
  // convention better than the simplified "2:1".
  const frTokens = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*fr\b/g)].map((m) => Number(m[1]));
  if (frTokens.length >= 2) {
    return frTokens.join(":");
  }

  // Fallback: count column tokens (space-separated, excluding fr-less things)
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) return `${tokens.length}-column custom track`;

  return "single-column or custom track";
}

/**
 * Derive a short use description from class name + ratio.
 */
function deriveRole(className: string, ratio: string, fillsFrame: boolean): string {
  const lowered = className.toLowerCase();
  const fillNote = fillsFrame ? " (fills remaining frame)" : "";

  if (/(img|image|picture|figure)/.test(lowered)) {
    return `Image+content composition, ${ratio}${fillNote}.`;
  }
  if (/(pipeline|timeline|process|step)/.test(lowered)) {
    return `Process/timeline grid, ${ratio}${fillNote}.`;
  }
  if (/(row|line)/.test(lowered)) {
    return `Row-aligned grid, ${ratio}${fillNote}.`;
  }
  if (/(split|half)/.test(lowered)) {
    return `Split composition, ${ratio}${fillNote}.`;
  }
  if (/(stat|metric|kpi|number)/.test(lowered)) {
    return `Data/metric layout, ${ratio}${fillNote}.`;
  }
  if (/matrix|grid/.test(lowered) && /×|matrix/.test(ratio)) {
    return `${ratio} cell matrix${fillNote}.`;
  }
  if (/^grid-\d/.test(lowered)) {
    return `Grid preset, ${ratio}${fillNote}.`;
  }
  return `${ratio}${fillNote}.`;
}

/**
 * Find every top-level single-class rule that defines a grid container.
 * Returns presets in document order, deduped by class name (first
 * occurrence wins — canonical definition usually precedes overrides).
 */
export function parseGridPresets(css: string): ParsedGridPreset[] {
  if (!css || css.length === 0) return [];

  const normalized = stripAtMediaBlocks(stripCssComments(css));
  const out: ParsedGridPreset[] = [];
  const seen = new Set<string>();

  // Match `selector { body }` rule blocks (non-nested — we already
  // stripped @media).
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(normalized)) !== null) {
    const rawSelector = m[1].trim();
    const body = m[2];

    // Skip blocks that aren't pure rules (e.g. @keyframes leaked, :root)
    if (rawSelector.startsWith("@") || rawSelector.startsWith(":")) continue;

    const selectors = splitGroupedSelector(rawSelector);
    if (selectors.length === 0) continue;
    if (!selectors.every(selectorIsSingleClass)) continue;

    const decls = parseDeclarations(body);

    // Must have BOTH display:grid AND grid-template-columns to qualify
    // as a canonical grid preset (vs a responsive override or unrelated
    // rule).
    if (!/grid/i.test(decls["display"] ?? "")) continue;
    const columns = decls["grid-template-columns"];
    if (!columns) continue;

    const rows = decls["grid-template-rows"];
    const gap = decls["gap"] ?? decls["grid-gap"];
    const alignItems = decls["align-items"];
    const padding = decls["padding"];
    const flex = decls["flex"];
    const fillsFrame = !!flex && /(^|\s)1\b/.test(flex);

    const ratio = summarizeColumns(columns, rows);

    for (const sel of selectors) {
      const className = sel.replace(/^\./, "");
      if (seen.has(className)) continue;
      seen.add(className);
      out.push({
        className,
        columns,
        rows,
        gap,
        alignItems,
        padding,
        fillsFrame,
        ratio,
        role: deriveRole(className, ratio, fillsFrame),
      });
    }
  }

  return out;
}

/**
 * Render the parsed presets as compositionSignatures-ready strings.
 * Returned strings are clearly marked with the "GRID PRESET:" prefix so
 * the renderer prompt can distinguish them from existing meta entries
 * in compositionSignatures.
 */
export function formatGridPresetSignatures(presets: ParsedGridPreset[]): string[] {
  if (presets.length === 0) return [];
  const lines: string[] = [];
  lines.push(
    "GRID PRIMITIVES (closed option set — use these class names verbatim on grid containers; NEVER write grid-template-columns inline):",
  );
  for (const p of presets) {
    const parts: string[] = [`  .${p.className} — ${p.ratio}`];
    if (p.gap) parts.push(`gap ${p.gap}`);
    if (p.alignItems) parts.push(`align-items:${p.alignItems}`);
    if (p.fillsFrame) parts.push("flex:1");
    lines.push(parts.join(", "));
  }
  return lines;
}
