/**
 * W9.3 — Lock-rules / anti-pattern parser.
 *
 * Per the AI-aesthetic-engineering methodology (品味免疫 §2.2),
 * negative knowledge is the highest-leverage way to prevent style
 * drift. Documented failure modes encoded as `现象 → 根因 → 做法` rules
 * stop the AI from re-discovering the same mistakes.
 *
 * This parser scans markdown documents that follow the lock-rule
 * pattern and emits 三段式 strings ready to be appended to
 * `profile.antiPatterns`. The schema stays `string[]` (no new top-level
 * field per the stability contract), but each string is now richly
 * structured so the renderer prompt's "antiPatterns is HARD CONSTRAINT"
 * directive has actionable content to enforce.
 *
 * Two markdown shapes recognised:
 *
 * SHAPE A — checklist.md style (severity-banded):
 *   ## 🔴 P0 · 一定不能犯的错
 *   ### 0-S. <rule name>
 *   **现象**: <line>
 *   **根因**: <line>
 *   **做法**: <line or bullet list>
 *
 * SHAPE B — lock files (numbered rules):
 *   ## 生成前硬规则
 *   1. <rule text>
 *   2. <rule text>
 *
 * Generic to any skill package — not bound to guizang vocabulary.
 * Synonyms accepted: 现象/Phenomenon/Symptom, 根因/Root cause/Cause,
 * 做法/Fix/Correct approach/Action.
 */

export type AntiPatternRule = {
  /** Severity tier extracted from heading (P0/P1/P2/P3) or "P1" default. */
  severity: "P0" | "P1" | "P2" | "P3";
  /** Rule title (display name). */
  title: string;
  /** Symptom / observed failure mode. */
  phenomenon?: string;
  /** Root cause explanation. */
  rootCause?: string;
  /** Correct approach / fix. */
  correctApproach?: string;
  /** Source document path (for audit). */
  sourceFile: string;
};

/**
 * Render an AntiPatternRule into a single string suitable for storage
 * in `profile.antiPatterns: string[]`. Keeps schema stable while
 * preserving the 三段式 structure so downstream renderer prompts can
 * present each rule with full context.
 */
export function formatAntiPatternRule(rule: AntiPatternRule): string {
  const parts: string[] = [`[${rule.severity}] ${rule.title}`];
  if (rule.phenomenon) parts.push(`现象: ${rule.phenomenon}`);
  if (rule.rootCause) parts.push(`根因: ${rule.rootCause}`);
  if (rule.correctApproach) parts.push(`做法: ${rule.correctApproach}`);
  return parts.join(" | ");
}

/**
 * Bold-marker extractor: finds `**LABEL**: value` patterns and
 * normalises label aliases.
 */
function extractStructuredField(body: string, labels: string[]): string | undefined {
  const labelPattern = labels.join("|");
  const re = new RegExp(`\\*\\*\\s*(?:${labelPattern})\\s*\\*\\*\\s*[:：]\\s*([^\\n]+(?:\\n(?:\\s*[-*+]\\s+[^\\n]+))*)`, "i");
  const match = body.match(re);
  if (!match) return undefined;
  return match[1].replace(/`/g, "").trim().slice(0, 400);
}

/**
 * Map a severity heading text to a P0/P1/P2/P3 tier.
 * Recognises numeric markers (🔴 P0, ⚠️ P1, 🟡 P2, 🟢 P3) and prose
 * fallbacks ("一定不能犯", "强烈建议", "最佳实践", "细节打磨").
 */
function inferSeverity(headingText: string): "P0" | "P1" | "P2" | "P3" {
  const lc = headingText.toLowerCase();
  if (/\bp0\b|🔴|一定不能|强禁|hard\s*rule|forbidden|must\s*not/.test(lc)) return "P0";
  if (/\bp1\b|⚠️|强烈建议|prevention|should\s*not/.test(lc)) return "P1";
  if (/\bp2\b|🟡|最佳实践|best\s*practice|recommended/.test(lc)) return "P2";
  if (/\bp3\b|🟢|细节|polish|tip/.test(lc)) return "P3";
  return "P1";
}

/**
 * Parse SHAPE A — checklist-style markdown with severity-banded
 * H2 sections and three-part H3 rules.
 */
export function parseChecklistMarkdown(md: string, sourceFile: string): AntiPatternRule[] {
  if (!md) return [];
  const out: AntiPatternRule[] = [];
  // Split by H2 sections to get severity bands
  const h2Sections = md.split(/^##\s+/m).slice(1);
  for (const section of h2Sections) {
    const lines = section.split(/\r?\n/);
    const h2Heading = lines[0]?.trim() ?? "";
    if (!h2Heading) continue;
    // Skip non-rule sections (intro, appendix)
    if (/intro|介绍|appendix|附录|preface|前言|目录|TOC/i.test(h2Heading)) continue;
    const severity = inferSeverity(h2Heading);

    const body = lines.slice(1).join("\n");
    // Split by H3 to get individual rules
    const h3Sections = body.split(/^###\s+/m).slice(1);
    for (const ruleBlock of h3Sections) {
      const ruleLines = ruleBlock.split(/\r?\n/);
      const h3Heading = ruleLines[0]?.trim() ?? "";
      if (!h3Heading) continue;
      // Strip leading numbering like "0-S. " or "1. "
      const title = h3Heading.replace(/^[\w-]+[.)]\s+/, "").replace(/^[`'"]+|[`'"]+$/g, "").trim().slice(0, 120);
      if (!title) continue;

      const ruleBody = ruleLines.slice(1).join("\n");
      const phenomenon = extractStructuredField(ruleBody, ["现象", "Phenomenon", "Symptom", "症状", "Issue"]);
      const rootCause = extractStructuredField(ruleBody, ["根因", "Root\\s*cause", "Cause", "原因", "Why"]);
      const correctApproach = extractStructuredField(ruleBody, ["做法", "Fix", "Correct(?:\\s*approach)?", "Action", "正确方式", "Resolution", "How"]);

      // Only emit when at least 2/3 fields populated — otherwise it's
      // probably a non-rule section masquerading as a heading.
      const fieldCount = [phenomenon, rootCause, correctApproach].filter(Boolean).length;
      if (fieldCount < 2) continue;

      out.push({ severity, title, phenomenon, rootCause, correctApproach, sourceFile });
    }
  }
  return out;
}

/**
 * Parse SHAPE B — lock-files with numbered hard rules under a
 * "生成前硬规则" / "Hard rules" heading.
 *
 * These rules are short — usually a single sentence describing what
 * must / must not be done. We treat them all as P0 severity since
 * lock-files are by definition non-negotiable.
 */
export function parseLockMarkdown(md: string, sourceFile: string): AntiPatternRule[] {
  if (!md) return [];
  const out: AntiPatternRule[] = [];
  // Find sections matching "硬规则" / "Hard rules" / "Lock rules" / "禁止"
  const sections = md.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const heading = lines[0]?.trim() ?? "";
    if (!heading) continue;
    if (!/硬规则|Hard\s*rules?|Lock\s*rules?|禁止|forbidden|must\s*not|prohibited|约束/i.test(heading)) continue;
    const body = lines.slice(1).join("\n");

    // Each numbered line = one rule
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      const num = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (!num) continue;
      const text = num[1].replace(/`/g, "").trim();
      if (text.length < 6) continue;
      // First clause becomes the title; the rest goes into correctApproach
      const period = text.search(/[。;.]/);
      const title = period > 0 ? text.slice(0, period).slice(0, 80) : text.slice(0, 80);
      const tail = period > 0 ? text.slice(period + 1).trim() : "";
      out.push({
        severity: "P0",
        title,
        correctApproach: tail || text,
        sourceFile,
      });
    }
  }
  return out;
}

/**
 * Generic entry point: pick the parser based on filename pattern.
 */
export function parseAntiPatternMarkdown(filePath: string, content: string): AntiPatternRule[] {
  if (/checklist|fidelity|quality[-_]?gates?/i.test(filePath)) {
    return parseChecklistMarkdown(content, filePath);
  }
  if (/lock|forbidden|rules|constraints?/i.test(filePath)) {
    return parseLockMarkdown(content, filePath);
  }
  // Fallback: try both and merge
  return [...parseChecklistMarkdown(content, filePath), ...parseLockMarkdown(content, filePath)];
}
