import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import { buildOpenPptExportArtifacts } from '../src/openppt-export.js';

const tmpRoots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'od-openppt-export-html-'));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OpenPPT HTML export player', () => {
  it('adds standalone fullscreen and iframe preview lightbox controls', async () => {
    const slideDir = tempRoot();
    const source = `
import type { DesignSystem, Page } from '@open-slide/core';
import { useState } from 'react';

export const design: DesignSystem = {
  palette: { bg: '#020617', text: '#f8fafc', accent: '#38bdf8' },
};

const DemoPage: Page = () => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ width: '100%', height: '100%', background: '#020617', color: '#f8fafc' }}>
      <div
        className="iframe-preview-box"
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') setOpen(true);
        }}
        role="button"
        tabIndex={0}
      >
        <iframe src="about:blank" title="Demo app" />
      </div>
      {open ? <div className="iframe-lightbox">Expanded</div> : null}
    </div>
  );
};

export default [DemoPage] satisfies Page[];
`;

    const artifacts = await buildOpenPptExportArtifacts({
      source,
      slideDir,
      title: 'Interactive export',
      target: 'assets',
    });

    if (!artifacts.zip) throw new Error('expected assets zip');
    const zip = await JSZip.loadAsync(artifacts.zip);
    const html = await zip.file('index.html')?.async('string');
    if (!html) throw new Error('expected exported index.html');

    expect(html).toContain('data-fullscreen');
    expect(html).toContain('toggleFullscreen');
    expect(html).toContain('openpptExportStageForward');
    expect(html).toContain('page.dataset.transition = transition');
    expect(html).toContain('class="export-canvas-inner" data-export-canvas-motion-root');
    expect(html).toContain('transform-origin: top left');
    expect(html).toContain('.export-page:not(.active) .export-canvas-inner .os-motion');
    expect(html).toContain("document.querySelectorAll('.iframe-preview-box')");
    expect(html).toContain('openIframePreviewLightbox');
    expect(html).toContain('(document.fullscreenElement || document.body).append(overlay)');
    expect(html).toContain('data-export-lightbox');
  }, 30_000);

  it('prepends Vault token stylesheet before OpenPPT export CSS', async () => {
    const slideDir = tempRoot();
    const tokenStylesheet = `<style>
:root {
  --dv-color-bg: #ffffff;
  --dv-color-text: #000000;
  --dv-color-role-hero: #27b36f;
  --dv-color-role-deep-section: #244544;
  --dv-duration-base: 2000ms;
  --dv-radius-xs: 0px;
  --dv-radius-card: var(--dv-radius-xs);
  --dv-bg: var(--dv-color-bg);
  --dv-text-primary: var(--dv-color-text);
  --dv-motion-reveal: var(--dv-duration-base);
  --dv-ease-standard: cubic-bezier(0.2, 0, 0, 1);
}
.dv-rounded-card { border-radius: var(--dv-radius-card); }
</style>`;
    const source = `
import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';

export const design: DesignSystem = {
  palette: { bg: 'var(--dv-bg)', text: 'var(--dv-text-primary)', accent: 'var(--dv-color-role-hero)' },
  radius: 'var(--dv-radius-card)',
};

const motionStyles = \`
.dv-test-reveal {
  transition: opacity var(--dv-motion-reveal) var(--dv-ease-standard);
}
.dv-test-reveal > * {
  animation-delay: 120ms;
}
\`;
const MotionStyles = () => <style>{motionStyles}</style>;

const Cover: Page = () => (
  <div
    className="dv-test-reveal"
    style={{
      width: '100%',
      height: '100%',
      background: 'var(--dv-bg)',
      color: 'var(--dv-text-primary)',
      borderRadius: 'var(--dv-radius-card)',
    }}
  >
    <MotionStyles />
    <h1 style={{ color: 'var(--dv-color-role-hero)' }}>Vault token deck</h1>
  </div>
);

export const meta: SlideMeta = { title: 'Vault token deck' };
export default [Cover] satisfies Page[];
`;

    const artifacts = await buildOpenPptExportArtifacts({
      source,
      slideDir,
      title: 'Vault token deck',
      target: 'assets',
      tokenStylesheet,
    });

    if (!artifacts.zip) throw new Error('expected assets zip');
    const zip = await JSZip.loadAsync(artifacts.zip);
    const html = await zip.file('index.html')?.async('string');
    const exportedSource = await zip.file('source.tsx')?.async('string');
    if (!html || !exportedSource) throw new Error('expected exported source files');

    const head = html.match(/<head>[\s\S]*?<\/head>/i)?.[0] ?? '';
    const firstStyle = head.match(/<style[\s\S]*?<\/style>/i)?.[0] ?? '';
    expect(firstStyle).toContain('--dv-color-role-hero: #27b36f');
    expect(firstStyle).toContain('--dv-color-role-deep-section: #244544');
    expect(firstStyle).toContain('--dv-duration-base: 2000ms');
    expect(firstStyle).toContain('--dv-radius-card: var(--dv-radius-xs)');
    expect(head.indexOf('--dv-color-role-hero')).toBeLessThan(head.indexOf('--osd-bg'));
    expect(html).toContain('background:var(--dv-bg)');
    expect(html).toContain('var(--dv-motion-reveal)');
    expect(html).toContain('.dv-test-reveal > *');
    expect(html).not.toContain('.dv-test-reveal &gt; *');
    expect(html).toContain('border-radius:var(--dv-radius-card)');
    expect(exportedSource).toContain("background: 'var(--dv-bg)'");
    expect(exportedSource).toContain('var(--dv-motion-reveal)');
    expect(exportedSource).not.toMatch(/borderRadius:\s*['"](?!0px|var\(--dv-radius-)/);
  }, 30_000);
});
