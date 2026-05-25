/**
 * W9.2 — Layout catalog parser.
 *
 * Many design systems articulate their layout primitives in a markdown
 * document organised as H2 sections, one per layout. Each section
 * typically contains:
 *
 *   - The layout name in the H2 heading
 *   - A short use / when-to-apply description
 *   - A fenced code block showing the actual HTML/JSX template
 *   - A bullet list of "要点 / Construction / Notes" describing the
 *     build steps + visual anchors
 *
 * This parser turns that document into structured
 * `ParsedLayoutBlock[]` that the project ingestion pipeline can drop
 * into `presentationStyle.slideArchetypes[]`. The downstream card /
 * PPT renderer prompt then reads slideArchetypes.construction VERBATIM
 * as composition instructions — turning the AI's task from "design
 * a layout from scratch" into "execute these documented steps".
 *
 * Generalization: works for any markdown that follows the H2-per-layout
 * convention. Section headers are pattern-matched generously
 * (`Layout N:`, `## <名称>`, etc.); construction extraction tries
 * several common patterns ("要点", "Notes", numbered lists, code-block
 * presence) so different authoring styles all funnel into the same
 * output shape.
 */

export type ParsedLayoutBlock = {
  /** Display name parsed from the H2 heading (cleaned). */
  name: string;
  /** One-line use / context (first short paragraph). */
  use?: string;
  /** Construction steps as prose strings, in order. */
  construction: string[];
  /** First fenced code block in the section (truncated). */
  codeSnippet?: string;
  /** Source heading verbatim (debug + audit). */
  rawHeading: string;
};

/**
 * H2 headings to SKIP — these are document chrome, not layout entries.
 * Pattern-matched generously to handle multiple authoring styles.
 */
const SKIP_HEADING_PATTERNS = [
  /preamble|pre-flight|前言|必读|必须先读|先读|生成前|生成后|审核/i,
  /基础结构|base structure|preliminaries|setup|baseline|基线|design language|设计语言/i,
  /附录|appendix|annex|历史实验|deprecated|legacy/i,
  /节奏建议|rhythm|cadence guidelines|page rhythm/i,
  /主题色|color scheme|palette$/i,
  /TOC|table of contents|目录/i,
  /^changelog|更新日志/i,
  /索引|index|选版式|常犯错误|errors?|mistakes?|检查项|检查表|gotchas?/i,
  /决策表|decision table|matrix|principles?|原则/i,
];

/**
 * Clean a markdown H2 line into a presentable layout name. Strips
 * leading numbering ("Layout 1:", "1.", "###" leftovers), emojis at
 * start, but keeps both Chinese and English portions of the name.
 */
function cleanLayoutHeading(line: string): string {
  let cleaned = line.replace(/^#+\s*/, "").trim();
  // Drop leading "Layout N:" / "样式 N:" / "Pattern N:" prefixes
  cleaned = cleaned.replace(/^(?:Layout|样式|Pattern|布局|示例|Example)\s*\d+\s*[:：·\-]\s*/i, "");
  // Drop leading numbering "1. " or "1) "
  cleaned = cleaned.replace(/^\d+[.)]\s*/, "");
  // Drop leading emoji + space
  cleaned = cleaned.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return cleaned.slice(0, 80);
}

/**
 * Extract numbered or bulleted lines that look like construction steps.
 * Recognises:
 *   - "**要点**:" / "**Construction**:" / "**Building**:" sub-headings
 *     followed by bulleted lines
 *   - Bare numbered lists "1. x" / "1) x" at the start of section
 *   - Bare bullet lists "- x" / "* x"
 *
 * Returns the cleaned step strings.
 */
/**
 * Inline structured labels (single-line markers) that authors use to
 * articulate construction sub-aspects. Each labelled line becomes one
 * construction step. Pattern: `**LABEL**: value` on one line.
 *
 * Examples we want to capture:
 *   **骨架**: 左侧 axis 列 12px 圆点 + 1px 虚线轴 / 右侧节点信息
 *   **关键类**: .timeline-v .tl-node .tl-axis
 *   **动效 recipe**: timeline-vertical
 *   **网格规则**: axis 列 = 12px 固定
 *   **Skeleton**: left column 12px dots + right info column
 */
const INLINE_CONSTRUCTION_LABELS = [
  "骨架",
  "结构",
  "Skeleton",
  "Structure",
  "Composition",
  "Layout",
  "关键类",
  "Key class(?:es)?",
  "Selectors?",
  "动效",
  "动效\\s*recipe",
  "Motion(?:\\s*recipe)?",
  "Animation",
  "网格规则",
  "Grid(?:\\s*rules?)?",
  "间距",
  "Spacing",
  "字号",
  "字号规则",
  "Type\\s*size",
  "Typography",
  "Font",
  "对齐",
  "Alignment",
  "重点",
  "Emphasis",
  "Building\\s*blocks?",
  "Anchors?",
  "Visual\\s*anchors?",
];

function extractInlineConstructionLines(body: string): string[] {
  const labelPattern = INLINE_CONSTRUCTION_LABELS.join("|");
  // \*\*(label)\*\*\s*[:：]\s*(value-until-end-of-line)
  const re = new RegExp(`\\*\\*\\s*(${labelPattern})\\s*\\*\\*\\s*[:：]\\s*([^\\n]+)`, "gi");
  const steps: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const label = match[1].replace(/\s+/g, " ").trim();
    const value = match[2].replace(/`/g, "").trim();
    if (value) steps.push(`${label}: ${value}`);
  }
  return steps;
}

function extractConstructionSteps(sectionBody: string): string[] {
  // Pattern 1: explicit construction marker like `**要点**` / `**Notes**`
  // followed by a bullet block
  const markerRe = /\*\*(?:要点|Construction|Notes?|Building blocks?|Structure|构造|步骤|Steps?)\*\*\s*[:：]?\s*\n([\s\S]*?)(?=\n\n|\n#|$)/i;
  const markerMatch = sectionBody.match(markerRe);
  const blockSteps: string[] = [];
  if (markerMatch) {
    const block = markerMatch[1];
    for (const line of block.split(/\r?\n/)) {
      const trimmed = line.trim();
      const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/) || trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (bulletMatch) blockSteps.push(bulletMatch[1].trim());
    }
  }

  // Pattern 2 (Swiss style): inline `**LABEL**: value` markers.
  // Each such line becomes one construction step.
  const inlineSteps = extractInlineConstructionLines(sectionBody);

  // Combine — block bullets first, then inline labels.
  const combined = [...blockSteps, ...inlineSteps];
  if (combined.length > 0) return combined;

  // Pattern 3 fallback: numbered list at start, before code block
  const codeBlockStart = sectionBody.search(/```/);
  const beforeCode = codeBlockStart > 0 ? sectionBody.slice(0, codeBlockStart) : sectionBody;
  const fallbackSteps: string[] = [];
  for (const line of beforeCode.split(/\r?\n/)) {
    const trimmed = line.trim();
    const num = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (num) fallbackSteps.push(num[1].trim());
  }
  if (fallbackSteps.length >= 2) return fallbackSteps;

  // Pattern 4 fallback: bullet list before code block
  fallbackSteps.length = 0;
  for (const line of beforeCode.split(/\r?\n/)) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet) fallbackSteps.push(bullet[1].trim());
  }
  return fallbackSteps;
}

/**
 * Extract the first non-empty paragraph from the section body (used
 * as the layout's "use" / when-to-apply summary).
 */
function extractUse(sectionBody: string): string | undefined {
  for (const line of sectionBody.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("```")) return undefined;  // code block before any prose
    if (trimmed.startsWith("**") || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+[.)]\s/.test(trimmed)) continue;
    // Strip markdown emphasis and link decoration
    return trimmed.replace(/\*\*|`/g, "").slice(0, 240) || undefined;
  }
  return undefined;
}

/**
 * Extract the FIRST fenced code block from a section. Truncates long
 * blocks to ~800 chars so the parsed evidence stays compact.
 */
function extractFirstCodeBlock(sectionBody: string): string | undefined {
  const match = sectionBody.match(/```(?:[a-z0-9_-]*)\n([\s\S]*?)```/i);
  if (!match) return undefined;
  const code = match[1].trim();
  return code.length > 800 ? code.slice(0, 800) + "\n…" : code;
}

/**
 * Recognise an H2 header that is a CATALOG WRAPPER ("22 个登记版式",
 * "Catalog", "All Layouts") rather than a single layout. When matched,
 * the parser should drill into the H3 entries underneath instead of
 * treating the H2 itself as one layout.
 */
const CATALOG_WRAPPER_PATTERNS = [
  /\d+\s*个\s*(?:登记|注册|可选|核心|主要)?版式/i,
  /\d+\s*(?:个)?\s*(?:核心|可选|常用)?\s*layouts?/i,
  /^(?:登记|catalog|主版式|all\s+layouts?|全部\s*版式|版式索引)/i,
  /^(?:layouts?|patterns?)\s*[:：]/i,
];

function looksLikeCatalogWrapper(heading: string): boolean {
  return CATALOG_WRAPPER_PATTERNS.some((re) => re.test(heading));
}

/**
 * Split a body into H3 sub-sections (catalog drill-in). Each entry
 * yields a `{heading, body}` pair.
 */
function splitH3Sections(body: string): Array<{ heading: string; body: string }> {
  const sections = body.split(/^###\s+/m).slice(1);
  const out: Array<{ heading: string; body: string }> = [];
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    out.push({
      heading: lines[0]?.trim() ?? "",
      body: lines.slice(1).join("\n"),
    });
  }
  return out;
}

/**
 * Look for a `**用途**: ...` / `**Use**: ...` etc. line in the section
 * and return its content (this beats the generic first-paragraph
 * heuristic for structured authoring like Swiss layouts-swiss.md).
 */
function extractStructuredUse(body: string): string | undefined {
  const re = /\*\*(?:用途|说明|Use|目的|Purpose|场景|Scenario|适用|适合|Suitable for)\*\*\s*[:：]\s*(.+)$/im;
  const match = body.match(re);
  if (!match) return undefined;
  return match[1].replace(/\*\*|`/g, "").trim().slice(0, 240);
}

function buildBlockFromSection(rawHeading: string, body: string): ParsedLayoutBlock | null {
  const name = cleanLayoutHeading(rawHeading);
  if (!name) return null;

  const construction = extractConstructionSteps(body);
  const use = extractStructuredUse(body) ?? extractUse(body);
  const codeSnippet = extractFirstCodeBlock(body);

  if (!construction.length && !use && !codeSnippet) return null;

  return { name, use, construction, codeSnippet, rawHeading };
}

/**
 * Parse a layouts catalog markdown document into structured layout
 * blocks. Handles both H2-per-layout (magazine style: each `## Layout
 * N: …`) and catalog-wrapper-with-H3-entries (swiss style: a single
 * `## 22 个登记版式` containing N `### P1 · Cover` subsections).
 * Returns an empty array when the document has no parseable layout
 * sections.
 */
export function parseLayoutCatalog(md: string): ParsedLayoutBlock[] {
  if (!md) return [];
  const sections = md.split(/^##\s+/m).slice(1);
  const blocks: ParsedLayoutBlock[] = [];

  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const rawHeading = lines[0]?.trim() ?? "";
    if (!rawHeading) continue;
    if (SKIP_HEADING_PATTERNS.some((re) => re.test(rawHeading))) continue;
    const body = lines.slice(1).join("\n");

    // Catalog wrapper: drill into H3 entries
    if (looksLikeCatalogWrapper(rawHeading)) {
      for (const sub of splitH3Sections(body)) {
        if (!sub.heading) continue;
        const block = buildBlockFromSection(sub.heading, sub.body);
        if (block) blocks.push(block);
      }
      continue;
    }

    // Single layout H2
    const block = buildBlockFromSection(rawHeading, body);
    if (block) blocks.push(block);
  }

  return blocks;
}
