/**
 * W9.4 — Component catalog parser.
 *
 * Per the AI-aesthetic-engineering methodology (§1.2 传组件不传描述),
 * documented components are FIXED VOCABULARY — each information type
 * maps to one and only one component with a fixed internal structure.
 * AI's job is "select from these components", not "design new ones".
 *
 * Skill authors articulate components in markdown sections shaped like:
 *
 *   ## ComponentName 中文名
 *   说明 prose...
 *
 *   ```html
 *   <div class="component-name">
 *     <span class="component-name-label">...</span>
 *     <span class="component-name-body">...</span>
 *   </div>
 *   ```
 *
 *   **使用要点 / Notes / Use**:
 *   - ...
 *
 * This parser extracts the component's CSS class name, its internal
 * structure (child classes in document order), and its prose use
 * description. Output drops into the existing
 * `profile.componentSignatures[]` slot.
 *
 * Generic across PPT skills, component libraries (shadcn / radix
 * docs), and anywhere upstream authors enumerate components by name
 * with fixed structure.
 */

export type ParsedComponentBlock = {
  /** Display name from the H2 heading. */
  name: string;
  /** One-line role / use summary. */
  role: string;
  /** Child class names in document order from the example HTML. */
  traits: string[];
  /** State / variant labels referenced in prose. */
  states: string[];
};

const SKIP_HEADING_PATTERNS = [
  /目录|TOC|table\s*of\s*contents|index/i,
  /preamble|前言|introduction|概述/i,
  /附录|appendix|annex/i,
  /更新日志|changelog/i,
];

const STATE_KEYWORDS = /hover|focus|active|disabled|selected|pressed|loading|empty|invalid|success|warning|error|状态|hover\s*态|active\s*态/gi;

/**
 * Clean an H2 heading line into a component name (preserves both
 * English and Chinese parts; strips decorative emoji and numbering).
 */
function cleanComponentHeading(line: string): string {
  return line
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim()
    .slice(0, 80);
}

/**
 * Extract the FIRST fenced HTML / JSX code block in the section.
 */
function extractCodeBlock(body: string): string | null {
  const match = body.match(/```(?:html|jsx|tsx|vue)?\n([\s\S]*?)```/i);
  return match ? match[1] : null;
}

/**
 * Pull class names referenced by class= or className= attributes in
 * an HTML/JSX snippet, in document order, deduped.
 */
function extractClassesFromCode(code: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of code.matchAll(/class(?:Name)?\s*=\s*["']([^"']+)["']/g)) {
    const tokens = m[1].split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Look for use / role / 用途 summary in the section. Prefers
 * structured `**用途**: ...` markers, falls back to first paragraph.
 */
function extractRole(body: string): string {
  const structured = body.match(/\*\*(?:用途|说明|Use|Role|Purpose|描述|Description)\*\*\s*[:：]\s*([^\n]+)/i);
  if (structured) return structured[1].replace(/`/g, "").trim().slice(0, 160);

  // Fallback: first non-empty non-bullet line before the first code block
  const codeStart = body.search(/```/);
  const beforeCode = codeStart > 0 ? body.slice(0, codeStart) : body;
  for (const line of beforeCode.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[#*\->`]/.test(trimmed)) continue;
    if (trimmed.startsWith("|") || trimmed.startsWith("---")) continue;
    return trimmed.replace(/\*\*|`/g, "").slice(0, 160);
  }
  return "Component documented in upstream catalog.";
}

/**
 * Pull state labels from the section body (hover / focus / active /
 * disabled / loaded etc.).
 */
function extractStates(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(STATE_KEYWORDS)) {
    out.add(m[0].toLowerCase());
  }
  return Array.from(out);
}

/**
 * Parse a components catalog markdown document into structured
 * component blocks. Both H2-per-component and H2-catalog-with-H3
 * patterns supported (same dual-mode strategy as layout parser).
 */
export function parseComponentCatalog(md: string): ParsedComponentBlock[] {
  if (!md) return [];
  const out: ParsedComponentBlock[] = [];
  const sections = md.split(/^##\s+/m).slice(1);

  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const heading = lines[0]?.trim() ?? "";
    if (!heading) continue;
    if (SKIP_HEADING_PATTERNS.some((re) => re.test(heading))) continue;

    const body = lines.slice(1).join("\n");

    // Detect catalog-wrapper H2: multiple H3 entries directly underneath
    const h3Count = (body.match(/^###\s+/gm) || []).length;
    const hasOwnCode = /```/.test(body.split(/^###\s+/m)[0] ?? "");
    if (h3Count >= 3 && !hasOwnCode) {
      // Drill into H3 entries
      for (const subSection of body.split(/^###\s+/m).slice(1)) {
        const subLines = subSection.split(/\r?\n/);
        const subHeading = subLines[0]?.trim() ?? "";
        if (!subHeading) continue;
        const subBody = subLines.slice(1).join("\n");
        const block = buildComponentBlock(subHeading, subBody);
        if (block) out.push(block);
      }
      continue;
    }

    const block = buildComponentBlock(heading, body);
    if (block) out.push(block);
  }
  return out;
}

function buildComponentBlock(headingLine: string, body: string): ParsedComponentBlock | null {
  const name = cleanComponentHeading(headingLine);
  if (!name) return null;

  const code = extractCodeBlock(body);
  const traits = code ? extractClassesFromCode(code).slice(0, 8) : [];
  const role = extractRole(body);
  const states = extractStates(body);

  // Only keep components with EITHER a code example OR a substantive
  // role description. Pure prose-essay H2 sections are excluded.
  if (traits.length === 0 && role.length < 16) return null;

  return { name, role, traits, states };
}
