import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import { buildOpenPptExportArtifacts } from '../src/openppt-export.js';

const tmpRoots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'od-openppt-export-pptx-'));
  tmpRoots.push(root);
  return root;
}

async function slideXmlFromPptx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string');
  if (!slideXml) throw new Error('expected slide XML');
  return slideXml;
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OpenPPT editable PPTX export fidelity', () => {
  it('keeps inline highlighted text as a single rich text box instead of duplicated layers', async () => {
    const slideDir = tempRoot();
    const source = `
import type { DesignSystem, Page } from '@open-slide/core';

export const design: DesignSystem = {
  palette: { bg: '#000000', text: '#ffffff', accent: '#d9f94a' },
  fonts: { display: 'Inter, sans-serif', body: 'Inter, sans-serif' },
};

const PageOne: Page = () => (
  <div style={{ width: '100%', height: '100%', background: '#000', color: '#fff', padding: 96 }}>
    <h1 style={{ margin: 0, fontSize: 70, lineHeight: 1.08, fontWeight: 800 }}>
      问题是把看到的好设计，变成 Agent 能复现、能迁移的
      <span style={{ color: '#d9f94a' }}>设计契约</span>
      。
    </h1>
  </div>
);

export default [PageOne] satisfies Page[];
`;

    const artifacts = await buildOpenPptExportArtifacts({
      source,
      slideDir,
      title: 'Inline rich text',
      target: 'pptx',
      pptxStrategy: 'editable',
    });

    if (!artifacts.pptx) throw new Error('expected PPTX buffer');
    const slideXml = await slideXmlFromPptx(artifacts.pptx);
    const highlightedTextOccurrences = (slideXml.match(/设计契约/g) || []).length;
    expect(highlightedTextOccurrences).toBe(1);
    expect(slideXml).toContain('val="D9F94A"');
  }, 30_000);

  it('preserves object-fit contain images instead of stretching them to the CSS box', async () => {
    const slideDir = tempRoot();
    const assetsDir = path.join(slideDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      path.join(assetsDir, 'square.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#111"/><circle cx="300" cy="300" r="220" fill="#d9f94a"/></svg>',
      'utf8',
    );
    const source = `
import type { DesignSystem, Page } from '@open-slide/core';
import square from './assets/square.svg';

export const design: DesignSystem = {
  palette: { bg: '#000000', text: '#ffffff', accent: '#d9f94a' },
};

const PageOne: Page = () => (
  <div style={{ width: '100%', height: '100%', background: '#000', position: 'relative' }}>
    <img
      src={square}
      alt="Square visual"
      style={{
        position: 'absolute',
        left: 280,
        top: 280,
        width: 920,
        height: 260,
        objectFit: 'contain',
      }}
    />
  </div>
);

export default [PageOne] satisfies Page[];
`;

    const artifacts = await buildOpenPptExportArtifacts({
      source,
      slideDir,
      title: 'Image contain',
      target: 'pptx',
      pptxStrategy: 'editable',
    });

    if (!artifacts.pptx) throw new Error('expected PPTX buffer');
    const slideXml = await slideXmlFromPptx(artifacts.pptx);
    expect(slideXml).toContain('<a:srcRect');
    expect(slideXml).not.toContain('<a:stretch><a:fillRect/></a:stretch>');
  }, 30_000);
});
