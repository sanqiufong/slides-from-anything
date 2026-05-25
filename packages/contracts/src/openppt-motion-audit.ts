export interface OpenPptMotionCoverageOptions {
  required?: boolean;
  minCoverageRatio?: number;
}

export interface OpenPptMotionCoverageAudit {
  pageCount: number;
  appliedMotionCount: number;
  uniqueMotionIdCount: number;
  coverageRatio: number;
  hasMotionStyles: boolean;
  hasFreezeMotionRule: boolean;
  hasReducedMotionRule: boolean;
  hasChoreographyMap: boolean;
  hasPageTransitionCue: boolean;
  pass: boolean;
  issues: string[];
  warnings: string[];
}

const DEFAULT_MIN_COVERAGE_RATIO = 0.6;
const DEFAULT_PAGE_COUNT = 1;

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function uniqueMatches(source: string, pattern: RegExp): Set<string> {
  const matches = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) matches.add(value);
  }
  return matches;
}

function stripTemplateLiterals(source: string): string {
  return source.replace(/`[\s\S]*?`/g, '``');
}

function countAppliedMotionClasses(source: string): number {
  const helperPattern = String.raw`(?:os-motion|os-fade-up|os-line-grow|os-canvas-swap|os-motion-stagger)`;
  const sourceWithoutTemplateLiterals = stripTemplateLiterals(source);
  return countMatches(sourceWithoutTemplateLiterals, new RegExp(String.raw`\bclassName\s*=\s*["'][^"']*\b${helperPattern}\b[^"']*["']`, 'g'))
    + countMatches(sourceWithoutTemplateLiterals, new RegExp(String.raw`\bclassName\s*:\s*["'][^"']*\b${helperPattern}\b[^"']*["']`, 'g'));
}

function countDefaultExportPages(source: string): number {
  const defaultExport = source.match(/export\s+default\s+\[([\s\S]*?)\]\s*satisfies\s+Page\[\]/m)
    ?? source.match(/export\s+default\s+\[([\s\S]*?)\]/m);
  const body = defaultExport?.[1];
  if (!body) return DEFAULT_PAGE_COUNT;
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const entries = withoutComments
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Math.max(DEFAULT_PAGE_COUNT, entries.length);
}

export function auditOpenPptMotionCoverage(
  source: string,
  options: OpenPptMotionCoverageOptions = {},
): OpenPptMotionCoverageAudit {
  const pageCount = countDefaultExportPages(source);
  const required = options.required ?? true;
  const minCoverageRatio = options.minCoverageRatio ?? DEFAULT_MIN_COVERAGE_RATIO;
  const directMotionIds = uniqueMatches(source, /data-osd-motion-id["']?\s*[:=]\s*["']([^"']+)["']/g);
  const motionAttrIds = uniqueMatches(source, /motionAttrs?\(\s*["']([^"']+)["']/g);
  const motionClassCount = countAppliedMotionClasses(source);
  const customMotionAttrCount = countMatches(source, /data-osd-motion-id/g);
  const appliedMotionCount = Math.max(motionClassCount, customMotionAttrCount + motionAttrIds.size);
  const uniqueMotionIdCount = new Set([...directMotionIds, ...motionAttrIds]).size;
  const coverageRatio = pageCount > 0 ? Math.min(1, appliedMotionCount / pageCount) : 0;
  const hasMotionStyles = /\bMotionStyles\b/.test(source) || /@keyframes\b/.test(source);
  const hasFreezeMotionRule = /\bdata-osd-freeze-motion\b/.test(source);
  const hasReducedMotionRule = /prefers-reduced-motion\s*:\s*reduce/.test(source);
  const hasChoreographyMap = /Motion Choreography Map|motionChoreography|choreographyMap|page-by-page motion/i.test(source);
  const hasPageTransitionCue = /\bos-canvas-swap\b|pageTransition|canvas swap|slide-enter|page-enter/i.test(source);
  const issues: string[] = [];
  const warnings: string[] = [];

  if (required && pageCount > 1 && appliedMotionCount === 0) {
    issues.push('No applied motion markers or OpenPPT motion helper classes were found.');
  }
  if (required && pageCount >= 3 && coverageRatio < minCoverageRatio) {
    issues.push(`Motion coverage ${Math.round(coverageRatio * 100)}% is below the ${Math.round(minCoverageRatio * 100)}% gate.`);
  }
  if (required && !hasChoreographyMap) {
    issues.push('Missing page-by-page motion choreography map.');
  }
  if (required && !hasMotionStyles) {
    issues.push('Missing MotionStyles or keyframe-backed motion definitions.');
  }
  if (required && !hasFreezeMotionRule) {
    issues.push('Missing data-osd-freeze-motion final-state rules.');
  }
  if (required && !hasReducedMotionRule) {
    issues.push('Missing prefers-reduced-motion fallback.');
  }
  if (required && pageCount > 1 && !hasPageTransitionCue) {
    warnings.push('No slide/page transition cue found in deck source; OpenPPT player transition will still apply.');
  }

  return {
    pageCount,
    appliedMotionCount,
    uniqueMotionIdCount,
    coverageRatio,
    hasMotionStyles,
    hasFreezeMotionRule,
    hasReducedMotionRule,
    hasChoreographyMap,
    hasPageTransitionCue,
    pass: issues.length === 0,
    issues,
    warnings,
  };
}
