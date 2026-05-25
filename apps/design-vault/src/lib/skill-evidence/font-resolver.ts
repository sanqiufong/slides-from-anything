/**
 * W9.1 — Resolve real typography from upstream template HTML.
 *
 * The project-ingestion pipeline up to W8 read CSS variable *names*
 * (`var(--sans)`, `var(--mono)`) and either dropped them as
 * unresolvable or passed them to sanitizeFontFamily which fell back
 * to "Inter". Result: typographyRoles.display === "Inter" for every
 * skill package, regardless of whether the upstream author shipped
 * Playfair Display, Helvetica Neue, IBM Plex Mono, etc.
 *
 * This resolver does the reverse-engineering the previous pipeline
 * skipped. Given the raw HTML of a runnable template (e.g.
 * assets/template.html), it returns a real CSS font-family stack
 * for display / body / mono roles by:
 *
 *  1. Parsing Google Fonts <link> URLs for "loaded font families".
 *  2. Parsing `:root { --var: value }` definitions whose names
 *     look typographically meaningful.
 *  3. Detecting which variables are used by which structural
 *     selectors (h1/h2 → display; body/p → body; code/pre → mono).
 *  4. Resolving var() references inside font-family stacks into
 *     concrete family chains.
 *  5. Merging multi-script stacks (en + zh) into one extended
 *     font-family chain so CJK + Latin both render correctly.
 *
 * Pure function. No filesystem I/O — the caller reads the template
 * HTML and passes the string. This keeps the resolver portable
 * across URL ingestion + project ingestion + theoretical future
 * imports.
 *
 * Generalization: the heuristics are NAME-based, not content-based,
 * so they work for any package that ships an HTML template with a
 * `:root { --some-typographic-var: "Some Font", fallback }` block —
 * not just guizang.
 */

export type ResolvedFontStack = {
  display: string;
  body: string;
  mono: string;
  /** Source of the resolution, for debugging + audit. */
  source: "template-resolved" | "partial" | "fallback";
  /** Google-Fonts-loaded families, for debugging. */
  loadedFamilies?: string[];
};

/** Quote stripping for `"Font Name"` and `'Font Name'`. */
function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a CSS font-family stack into ordered family names.
 * Splits on commas outside quoted strings.
 */
function parseFontStack(value: string): string[] {
  const families: string[] = [];
  let buf = "";
  let inQuote: '"' | "'" | null = null;
  for (const ch of value) {
    if (inQuote) {
      buf += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      const cleaned = stripQuotes(buf).trim();
      if (cleaned) families.push(cleaned);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const last = stripQuotes(buf).trim();
  if (last) families.push(last);
  return families;
}

/**
 * Recursively resolve var(--x) references inside a font-family value
 * against the provided variable map. Caps recursion depth at 8 to
 * avoid pathological cyclic refs.
 */
function resolveVarStack(value: string, vars: Record<string, string>, depth = 0): string {
  if (depth > 8) return value;
  return value.replace(/var\(\s*--([a-z0-9_-]+)\s*(?:,\s*[^)]+)?\s*\)/gi, (_match, name: string) => {
    const ref = vars[name.toLowerCase()];
    if (!ref) return "";
    return resolveVarStack(ref, vars, depth + 1);
  });
}

/**
 * Detect the role of a CSS variable from its name.
 * Returns null if name does not look typographically meaningful.
 *
 * Heuristic discipline: a name is FONT-related only when it carries a
 * font / family / serif / sans / mono / display token. Plain "text-*"
 * or "title-*" without those tokens is AMBIGUOUS — often a color
 * (--text-primary, --title-color) or layout slot. We refuse to
 * classify those to avoid leaking hex codes into font stacks.
 */
function classifyVarName(name: string): "display" | "body" | "mono" | null {
  const lc = name.toLowerCase();
  // mono — most specific
  if (/(^|[-_])mono([-_]|$)|monospace|^(?:font[-_]?)?code$|font[-_]?mono/.test(lc)) return "mono";
  // display / serif — only when paired with display/font/family/serif tokens
  if (/(^|[-_])display([-_]|$)|(^|[-_])serif([-_]|$)|font[-_]?(?:display|heading|title|h[1-3])|heading[-_]?font|title[-_]?font/.test(lc)) {
    return "display";
  }
  // body / sans / primary — require an explicit font/family/sans token
  if (/(^|[-_])sans([-_]|$)|font[-_]?(?:family|body|sans|primary|main|base)|body[-_]?font/.test(lc)) {
    return "body";
  }
  return null;
}

/**
 * Sanity-check a CSS value before treating it as a font stack.
 * Rejects values whose ENTIRE chain looks like colors, durations,
 * easings, or numeric tokens — those classify as font by name but
 * resolve to non-typographic content.
 */
function looksLikeFontStackValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Pure hex / rgb / hsl / numeric — reject
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return false;
  if (/^rgba?\(/i.test(trimmed)) return false;
  if (/^hsla?\(/i.test(trimmed)) return false;
  if (/^cubic-bezier\(/i.test(trimmed)) return false;
  if (/^\d+(?:\.\d+)?(?:px|rem|em|vh|vw|s|ms|%)?$/i.test(trimmed)) return false;
  // Comma-separated list where every part is a hex / number — reject
  const parts = parseFontStack(trimmed);
  if (parts.length === 0) return false;
  const nonFontPartCount = parts.filter((p) =>
    /^#[0-9a-f]{3,8}$/i.test(p) || /^\d+(?:\.\d+)?(?:px|rem|em|vh|vw|s|ms|%)?$/i.test(p) || /^rgba?\(/i.test(p) || /^hsla?\(/i.test(p)
  ).length;
  return nonFontPartCount === 0;
}

/**
 * Extract all `<link>` URLs pointing at Google Fonts CSS2 and return
 * the list of `family=X` family names they declare. Multi-family URLs
 * use `&family=` separator; some legacy ones use `|` inside `family=`.
 */
function extractGoogleFontsFamilies(html: string): string[] {
  const families = new Set<string>();
  const linkMatches = html.match(/<link[^>]*href=["']([^"']*fonts\.googleapis\.com[^"']*)["'][^>]*>/gi) ?? [];
  for (const tag of linkMatches) {
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const url = hrefMatch[1];
    // Split on &family= to handle multi-family URLs
    const familyParams = url.match(/[?&]family=([^&]+)/g) ?? [];
    for (const param of familyParams) {
      const value = param.replace(/[?&]family=/, "");
      // Each value may itself be name|otherName (legacy v1) or just name:weight
      const parts = value.split("|");
      for (const part of parts) {
        // Strip `:wght@…` / `:ital,wght@…` / `:opsz,wght@…` etc.
        const family = decodeURIComponent(part.split(":")[0].replace(/\+/g, " ")).trim();
        if (family) families.add(family);
      }
    }
  }
  return Array.from(families);
}

/**
 * Extract :root (and html, * etc) CSS custom property definitions
 * from a <style> block scan.
 */
function extractCssVariables(html: string): Record<string, string> {
  const vars: Record<string, string> = {};
  // Collect all <style> blocks first.
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const css = styleBlocks.join("\n");
  // Find :root { … } or html { … } or :root, html { … } blocks.
  const rootRuleRe = /(?:^|[\s,])(?::root|html)\s*\{([^}]+)\}/g;
  let rootMatch: RegExpExecArray | null;
  while ((rootMatch = rootRuleRe.exec(css))) {
    const body = rootMatch[1];
    // Lines like `--name: value;`
    for (const m of body.matchAll(/--([a-z0-9_-]+)\s*:\s*([^;]+)/gi)) {
      vars[m[1].toLowerCase()] = m[2].trim();
    }
  }
  // Also catch standalone :root rules outside the regex (split form).
  for (const m of css.matchAll(/--([a-z0-9_-]+)\s*:\s*([^;{}]+);/g)) {
    if (!vars[m[1].toLowerCase()]) vars[m[1].toLowerCase()] = m[2].trim();
  }
  return vars;
}

/**
 * Detect which CSS variable a structural selector uses for its
 * `font-family`. Returns a list of variable names referenced
 * (in declaration order) for selectors matching the role.
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function findRoleSelectorVars(css: string, selectors: RegExp): string[] {
  const cleanCss = stripCssComments(css);
  const vars: string[] = [];
  const ruleRe = /([^{}]+)\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(cleanCss))) {
    const selector = m[1].trim();
    const body = m[2];
    if (!selectors.test(selector)) continue;
    const fontDecl = body.match(/font-family\s*:\s*([^;]+)/i);
    if (!fontDecl) continue;
    const value = fontDecl[1];
    // Pick out var(--x) references.
    const refs = [...value.matchAll(/var\(\s*--([a-z0-9_-]+)\s*(?:,\s*[^)]+)?\s*\)/gi)].map((vm) => vm[1].toLowerCase());
    vars.push(...refs);
    // Also concat any literal family names that aren't var() inside
    // — they often follow var() as the multi-script extension.
    const literalFamilies = parseFontStack(value).filter((f) => !/^var\(/.test(f.trim()));
    if (literalFamilies.length > 0) {
      // Use a synthetic key so later resolution treats them as inline.
      vars.push(`__inline:${literalFamilies.join(",")}`);
    }
  }
  return vars;
}

/**
 * Combine multiple resolved font stacks into one CSS font-family
 * declaration. Deduplicates families while preserving order.
 */
function mergeStacks(stacks: string[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const stack of stacks) {
    if (!stack) continue;
    for (const family of parseFontStack(stack)) {
      const key = family.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Re-quote families with spaces or non-letter chars
      merged.push(/[\s.]/.test(family) ? `"${family}"` : family);
    }
  }
  return merged.join(", ");
}

/**
 * Resolve typography from an upstream template HTML string.
 * Returns null if nothing typographically meaningful was found
 * (caller should keep its existing fallback).
 */
export function resolveTypographyFromTemplate(html: string): ResolvedFontStack | null {
  const vars = extractCssVariables(html);
  if (Object.keys(vars).length === 0) {
    // No CSS variables — try scanning structural rules directly.
    return resolveDirectFromSelectors(html);
  }

  // Group variables by inferred role.
  const groups: { display: string[]; body: string[]; mono: string[] } = {
    display: [],
    body: [],
    mono: [],
  };
  for (const [name, value] of Object.entries(vars)) {
    const role = classifyVarName(name);
    if (!role) continue;
    // Resolve any nested var() references.
    const resolved = resolveVarStack(value, vars);
    // Reject color / duration / numeric values that match by name only.
    if (resolved && /["a-zA-Z]/.test(resolved) && looksLikeFontStackValue(resolved)) {
      groups[role].push(resolved);
    }
  }

  // Also inspect what selectors USE these variables. If h1/h2 picks a
  // specific var (e.g. var(--serif-en), var(--serif-zh)), the value
  // chain should be display = serif-en + serif-zh, not just any var
  // matching name.
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  // Selector regexes require a selector-terminator (`,`, `>`, `~`, `+`,
  // whitespace, `:`, `[`, `(`, `{`, or end-of-string) AFTER the keyword
  // so prose / English letters embedded in Chinese text inside comments
  // (already stripped above) can't match. `(?![-\w])` negative lookahead
  // on class names blocks compound classes like `.body-serif`.
  const TERM = `(?:[\\s,>~+:.\\[({]|$)`;
  const PREFIX = `(?:^|[\\s,>~+({])`;
  const selectorBindings: Record<"display" | "body" | "mono", string[]> = {
    display: findRoleSelectorVars(
      styleBlocks,
      new RegExp(`${PREFIX}(?:h[1-3]${TERM}|\\.headline(?![-\\w])|\\.display(?![-\\w])|\\.title(?![-\\w])|\\.h[1-3](?![-\\w]))`, "i"),
    ),
    body: findRoleSelectorVars(
      styleBlocks,
      new RegExp(`${PREFIX}(?:body${TERM}|html${TERM}|p${TERM}|\\.body(?![-\\w])|\\.subtitle(?![-\\w])|\\.copy(?![-\\w]))`, "i"),
    ),
    mono: findRoleSelectorVars(
      styleBlocks,
      new RegExp(`${PREFIX}(?:code${TERM}|pre${TERM}|kbd${TERM}|samp${TERM}|\\.mono(?![-\\w])|\\.eyebrow(?![-\\w])|\\.meta(?![-\\w]))`, "i"),
    ),
  };
  for (const role of ["display", "body", "mono"] as const) {
    for (const ref of selectorBindings[role]) {
      if (ref.startsWith("__inline:")) {
        const inline = ref.slice("__inline:".length);
        if (looksLikeFontStackValue(inline)) groups[role].push(inline);
        continue;
      }
      const v = vars[ref];
      if (!v) continue;
      const resolved = resolveVarStack(v, vars);
      if (looksLikeFontStackValue(resolved)) groups[role].push(resolved);
    }
  }

  const display = mergeStacks(groups.display);
  const body = mergeStacks(groups.body);
  const mono = mergeStacks(groups.mono);

  const haveDisplay = Boolean(display);
  const haveBody = Boolean(body);
  const haveMono = Boolean(mono);
  if (!haveDisplay && !haveBody && !haveMono) return null;

  const loadedFamilies = extractGoogleFontsFamilies(html);

  return {
    display: display || body || mono || "system-ui, sans-serif",
    body: body || display || "system-ui, sans-serif",
    mono: mono || "ui-monospace, monospace",
    source: haveDisplay && haveBody ? "template-resolved" : "partial",
    loadedFamilies,
  };
}

/**
 * Fallback when there are no CSS variables: scan `body { font-family: }`
 * and `h1 { font-family: }` directly.
 */
function resolveDirectFromSelectors(html: string): ResolvedFontStack | null {
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  if (!styleBlocks) return null;
  const clean = stripCssComments(styleBlocks);
  const ruleRe = /([^{}]+)\{([^}]*font-family[^}]*)\}/gi;
  let m: RegExpExecArray | null;
  const buckets: { display: string[]; body: string[]; mono: string[] } = { display: [], body: [], mono: [] };
  // Same selector regexes as above for consistency.
  const TERM = `(?:[\\s,>~+:.\\[({]|$)`;
  const PREFIX = `(?:^|[\\s,>~+({])`;
  const reMono = new RegExp(`${PREFIX}(?:code${TERM}|pre${TERM}|kbd${TERM}|samp${TERM}|\\.mono(?![-\\w])|\\.eyebrow(?![-\\w])|\\.meta(?![-\\w]))`, "i");
  const reDisplay = new RegExp(`${PREFIX}(?:h[1-3]${TERM}|\\.headline(?![-\\w])|\\.display(?![-\\w])|\\.title(?![-\\w])|\\.h[1-3](?![-\\w]))`, "i");
  const reBody = new RegExp(`${PREFIX}(?:body${TERM}|html${TERM}|p${TERM}|\\.body(?![-\\w])|\\.subtitle(?![-\\w])|\\.copy(?![-\\w]))`, "i");
  while ((m = ruleRe.exec(clean))) {
    const selector = m[1].trim();
    const declBody = m[2];
    const decl = declBody.match(/font-family\s*:\s*([^;]+)/i);
    if (!decl) continue;
    const value = decl[1].trim();
    if (!looksLikeFontStackValue(value)) continue;
    if (reMono.test(selector)) buckets.mono.push(value);
    else if (reDisplay.test(selector)) buckets.display.push(value);
    else if (reBody.test(selector)) buckets.body.push(value);
  }
  const display = mergeStacks(buckets.display);
  const body = mergeStacks(buckets.body);
  const mono = mergeStacks(buckets.mono);
  if (!display && !body && !mono) return null;
  return {
    display: display || body || "system-ui, sans-serif",
    body: body || display || "system-ui, sans-serif",
    mono: mono || "ui-monospace, monospace",
    source: "partial",
    loadedFamilies: extractGoogleFontsFamilies(html),
  };
}
