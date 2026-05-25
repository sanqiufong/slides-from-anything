import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildOpenPptExportArtifacts } from '../src/openppt-export.js';
import { composeSystemPrompt } from '../src/prompts/system.js';
import {
  openPptDesignFromVaultTemplate,
  renderOpenPptStarterSlide,
  vaultTemplateMetadataFromDesign,
} from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const vaultMotionFixturePath = path.join(__dirname, 'fixtures/vault-design-motion-meta.json');
const tmpRoots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'od-openppt-motion-'));
  tmpRoots.push(root);
  return root;
}

function readVaultMotionFixture() {
  return JSON.parse(readFileSync(vaultMotionFixturePath, 'utf8')) as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OpenPPT Design Vault component motion', () => {
  it('passes real Design Vault componentMotionRecipes into project metadata and starter TSX', async () => {
    const design = readVaultMotionFixture();
    const metadata = await vaultTemplateMetadataFromDesign(design);

    expect(metadata?.componentMotionRecipes?.length).toBeGreaterThan(0);
    expect(metadata?.componentMotionRecipes?.length).toBeLessThanOrEqual(6);
    expect(metadata?.componentMotionRecipes?.[0]).toMatchObject({
      id: expect.any(String),
      component: expect.any(String),
      timing: expect.any(Object),
    });

    const inheritedDesign = openPptDesignFromVaultTemplate(metadata, {
      palette: { bg: '#ffffff', text: '#111111', accent: '#ff0000' },
      motion: { existing: true },
    } as any);
    expect(inheritedDesign.motion.existing).toBe(true);
    expect(inheritedDesign.motion.componentMotionRecipes).toHaveLength(metadata!.componentMotionRecipes!.length);
    expect(inheritedDesign.motion.approach).toEqual(metadata?.openSlideGuidance?.motionApproach ?? []);

    const source = renderOpenPptStarterSlide({ title: 'Mono motion deck', vaultTemplate: metadata });
    expect(source).toContain('const motionFromRecipe');
    expect(source).toContain('data-osd-motion-id');
    expect(source).toContain('os-dv-motion-');
    expect(source).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('includes vaultComponentMotionRecipes guidance in the system prompt', async () => {
    const design = readVaultMotionFixture();
    const metadata = await vaultTemplateMetadataFromDesign(design);
    const prompt = composeSystemPrompt({
      skillMode: 'deck',
      skillName: 'openppt-deck',
      skillBody: 'Edit slides/<slideId>/index.tsx directly.',
      metadata: {
        kind: 'deck',
        speakerNotes: false,
        vaultTemplate: metadata!,
      } as any,
    });

    expect(prompt).toContain('### vaultComponentMotionRecipes');
    expect(prompt).toContain('fixed-header-persistent-chrome-1');
    expect(prompt).toContain('MotionStyles');
    expect(prompt).toContain('motionFromRecipe');
    expect(prompt).toContain('data-osd-motion-id');
    expect(prompt).toContain('prefers-reduced-motion');
    expect(prompt).toContain('Motion Choreography Map');
    expect(prompt).toContain('Motion Coverage Gate');
    expect(prompt).toContain('60% threshold');
  });

  it('captures data-osd-motion-id and CSS animation metadata in editable PPTX stats', async () => {
    const slideDir = tempRoot();
    const source = `
import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';

export const design: DesignSystem = {
  palette: { bg: '#111111', text: '#f8fafc', accent: '#7dd3fc' },
  fonts: { display: 'Inter, sans-serif', body: 'Inter, sans-serif' },
  radius: 12,
};

const motionStyles = \`
@keyframes openpptDvHero {
  from { opacity: 0; transform: translate3d(0, 32px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
.os-motion {
  animation-duration: 420ms;
  animation-timing-function: cubic-bezier(0.2, 0.7, 0.2, 1);
  animation-fill-mode: both;
}
.os-dv-motion-hero-reveal {
  animation-name: openpptDvHero;
}
[data-osd-freeze-motion] .os-motion {
  animation: none !important;
  opacity: 1 !important;
  transform: none !important;
}
@media (prefers-reduced-motion: reduce) {
  .os-motion { animation: none !important; transform: none !important; }
}
\`;
const MotionStyles = () => <style>{motionStyles}</style>;
const motionFromRecipe = { "hero-reveal": "os-motion os-dv-motion-hero-reveal" } as const;
const motionAttrs = (id: keyof typeof motionFromRecipe) => ({
  className: motionFromRecipe[id],
  "data-osd-motion-id": id,
});

const Cover: Page = () => (
  <div style={{ width: '100%', height: '100%', padding: 120, background: '#111111', color: '#f8fafc' }}>
    <MotionStyles />
    <h1 {...motionAttrs("hero-reveal")} style={{ margin: 0, fontSize: 96, fontFamily: 'Inter, sans-serif' }}>
      Motion metadata
    </h1>
  </div>
);

export const meta: SlideMeta = { title: 'Motion metadata' };
export default [Cover] satisfies Page[];
`;

    const artifacts = await buildOpenPptExportArtifacts({
      source,
      slideDir,
      title: 'Motion metadata',
      target: 'pptx',
      pptxStrategy: 'editable',
    });

    expect(artifacts.pptxStrategy).toBe('editable');
    expect(artifacts.pptx).toBeInstanceOf(Buffer);
    expect(artifacts.pptxStats?.motionLayerCount).toBeGreaterThan(0);
  }, 30_000);
});
