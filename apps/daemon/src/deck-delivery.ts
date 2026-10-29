import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DeckDeliveryReport } from '@open-design/contracts/api/openppt';
import { auditOpenPptMotionCoverage } from '@open-design/contracts/openppt-motion-audit';
import { evaluateOpenPptDeck } from './openppt-export.js';

/** Reuse the actual export renderer, including module execution and Page[] rendering. */
export async function validateDeckSource(source: string, slideDir: string): Promise<{
  pageCount: number; htmlPages: string[];
}> {
  return evaluateOpenPptDeck({ source, slideDir, renderTimeoutMs: 5000 });
}

export async function checkDeckAssets(slideDir: string, source: string, htmlPages: string[]): Promise<{
  issues: string[]; warnings: string[];
}> {
  const references = new Set<string>();
  for (const match of source.matchAll(/(?:from\s*|import\s*|require\(\s*)['"]((?:\.\/)?assets\/[^'"]+)['"]/g)) references.add(match[1]!);
  const rendered = htmlPages.join('\n').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/gi, "'").replace(/&amp;/g, '&');
  for (const match of rendered.matchAll(/\b(?:src|poster|xlink:href)=["']([^"']+)["']/g)) references.add(match[1]!);
  for (const match of rendered.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)) references.add(match[1]!);
  const issues: string[] = [];
  const warnings: string[] = [];
  const root = await realpath(slideDir);
  for (const value of references) {
    if (/^(?:data:|#|about:)/i.test(value)) continue;
    if (/^(?:https?:)?\/\//i.test(value)) { warnings.push(`External asset was not downloaded or verified: ${value}`); continue; }
    try {
      const ref = decodeURIComponent(value.replace(/&amp;/g, '&').split(/[?#]/)[0]!);
      if (!ref || ref.includes('\\') || ref.includes('\0') || path.isAbsolute(ref)
        || /^[A-Za-z][A-Za-z\d+.-]*:/.test(ref)) throw new Error('unsupported asset path');
      const absolute = path.resolve(slideDir, ref);
      if (!absolute.startsWith(`${path.resolve(slideDir)}${path.sep}`)) throw new Error('asset escapes deck directory');
      // Reject symlinks in every path component, not just the final filename.
      let walked = slideDir;
      for (const part of path.relative(slideDir, absolute).split(path.sep)) {
        walked = path.join(walked, part);
        if ((await lstat(walked)).isSymbolicLink()) throw new Error('asset symlink');
      }
      const resolved = await realpath(absolute);
      if (!resolved.startsWith(`${root}${path.sep}`) || !(await lstat(absolute)).isFile()) throw new Error('asset is not a local file');
    } catch { issues.push(`Missing or unsafe local asset: ${value}`); }
  }
  return { issues, warnings };
}

export async function checkDeckDelivery(input: {
  slideId: string;
  slideDir: string;
  changed: boolean;
  animations: boolean;
  mediaRequired?: boolean;
}): Promise<DeckDeliveryReport> {
  const report: DeckDeliveryReport = {
    status: input.changed ? 'passed' : 'not_required', checkedAt: Date.now(), slideId: input.slideId,
    checks: [], warnings: [], visualReview: 'pending',
  };
  if (!input.changed) {
    report.warnings.push('The target deck files did not change in this run; no new deck delivery is certified.');
    return report;
  }
  let source: string;
  try {
    const file = path.join(input.slideDir, 'index.tsx');
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Deck source may not be a symlink.');
    source = await readFile(file, 'utf8');
    report.sourceDigest = createHash('sha256').update(source).digest('hex');
    report.checks.push({ name: 'source', status: 'passed', issues: [] });
  } catch (error) {
    report.status = 'failed';
    report.checks.push({ name: 'source', status: 'failed', issues: [String((error as Error).message)] });
    return report;
  }
  let rendered: Awaited<ReturnType<typeof validateDeckSource>>;
  try {
    rendered = await validateDeckSource(source, input.slideDir);
    report.pageCount = rendered.pageCount;
    report.checks.push({ name: 'render', status: 'passed', issues: [] });
  } catch (error) {
    report.status = 'failed';
    report.checks.push({ name: 'render', status: 'failed', issues: [String((error as Error).message)] });
    return report;
  }
  const assets = await checkDeckAssets(input.slideDir, source, rendered.htmlPages);
  if (input.mediaRequired && /<ImagePlaceholder\b/.test(source)) assets.issues.push('Required deck imagery still contains ImagePlaceholder.');
  report.checks.push({ name: 'assets', status: assets.issues.length ? 'failed' : 'passed', issues: assets.issues });
  report.warnings.push(...assets.warnings);
  const motion = auditOpenPptMotionCoverage(source, { required: input.animations });
  report.checks.push({ name: 'motion', status: input.animations ? (motion.pass ? 'passed' : 'failed') : 'skipped', issues: motion.issues });
  report.warnings.push(...motion.warnings);
  if (report.checks.some(check => check.status === 'failed')) report.status = 'failed';
  report.warnings.push('Static rendering and source checks do not certify visual quality, interaction or external resources.');
  return report;
}
