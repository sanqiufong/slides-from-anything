/**
 * W9.3 — Rhythm parser.
 *
 * Per the AI-aesthetic-engineering methodology (品味传承 §3.3),
 * cross-unit rhythm is a STRUCTURAL CONSTRAINT, not aesthetic
 * preference. A 25-slide deck where every slide looks like a
 * good single slide can still feel exhausting if there's no
 * dark/light alternation. Conversely, 20 hero slides in a row
 * fatigues the viewer even if each individual hero is gorgeous.
 *
 * Skill authors often articulate rhythm in a dedicated markdown
 * section. We scan for those sections and extract:
 *
 *   - A SEQUENCE of slide-type labels (the pattern template)
 *   - HARD CONSTRAINTS (no more than N consecutive same-type)
 *   - EMPHASIS CADENCE (key moments / where to land impact)
 *
 * Output drops into the existing
 * `profile.presentationStyle.themeRhythm` slot — schema unchanged.
 */

export type ParsedRhythm = {
  /** Suggested sequence of slide-type labels (e.g. ["hero dark", "light", "dark"]). */
  pattern: string[];
  /** Hard alternation / consecutive-cap rules as prose. */
  rules: string[];
  /** Key moments / emphasis cadence guidance as prose. */
  cadence: string[];
};

const RHYTHM_HEADING_PATTERNS = [
  /节奏建议|rhythm|cadence|narrative\s*arc/i,
  /流程节奏|page\s*rhythm/i,
  /叙事节奏|story\s*rhythm/i,
  /主题节奏|theme\s*rhythm/i,
  /节奏规划|rhythm\s*plan/i,
];

/**
 * Extract numbered or bulleted sequence items that look like slide-type
 * progression. Strips emphasis markers + trailing parentheticals so
 * the output is a clean type label.
 */
function extractSequenceItems(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    const num = trimmed.match(/^\d+[.)]\s+\*?\*?(.+)$/);
    const bullet = trimmed.match(/^[-*+]\s+\*?\*?(.+)$/);
    const raw = num?.[1] || bullet?.[1];
    if (!raw) continue;
    // Take only the bold-labelled lead phrase, before any opening paren or em-dash
    const label = raw.replace(/\*\*/g, "").split(/[（(—–:：]/)[0].trim();
    if (!label) continue;
    if (label.length > 80) continue;
    items.push(label);
  }
  return items;
}

/**
 * Extract HARD constraint sentences (no more than N consecutive, must
 * have ≥1 of X, alternation ratio, etc.).
 */
function extractHardRules(body: string): string[] {
  const rules: string[] = [];
  // Look for sentences with constraint vocabulary
  const constraintMarkers = /不要连续|不超过|至少|必须|至多|consecutive|cap|ratio|比例|交错|alternation/i;
  for (const sentence of body.split(/[。\n.!?]/)) {
    const t = sentence.trim();
    if (!t || t.length < 10) continue;
    if (constraintMarkers.test(t)) {
      // Clean up markdown decoration
      const cleaned = t.replace(/\*\*|`/g, "").replace(/^\s*[-*+\d.)\s]+/, "").trim();
      if (cleaned.length > 6 && cleaned.length < 200) {
        rules.push(cleaned);
      }
    }
  }
  return rules;
}

/**
 * Extract narrative cadence / emphasis points (key moments).
 */
function extractCadence(body: string): string[] {
  const cadence: string[] = [];
  // Look for phrases like "钩子", "Hook", "高潮", "Climax", "转折", "Turning point"
  const cadenceMarkers = /钩子|定调|主体|转折|收束|hook|act\s*\d|climax|turning|opening|closing|finale/i;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (cadenceMarkers.test(t)) {
      const cleaned = t.replace(/^[-*+\d.)\s]+/, "").replace(/\*\*|`/g, "").trim();
      if (cleaned.length > 6 && cleaned.length < 200) cadence.push(cleaned);
    }
  }
  return cadence;
}

/**
 * Parse a markdown document looking for rhythm guidance. Scans every
 * H2 section; only those whose heading matches RHYTHM_HEADING_PATTERNS
 * are mined.
 */
export function parseRhythmGuidance(md: string): ParsedRhythm | null {
  if (!md) return null;
  const sections = md.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const heading = lines[0]?.trim() ?? "";
    if (!heading) continue;
    if (!RHYTHM_HEADING_PATTERNS.some((re) => re.test(heading))) continue;
    const body = lines.slice(1).join("\n");

    const pattern = extractSequenceItems(body);
    const rules = extractHardRules(body);
    const cadence = extractCadence(body);

    if (pattern.length === 0 && rules.length === 0 && cadence.length === 0) continue;
    return { pattern, rules, cadence };
  }
  return null;
}
