import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildVaultAgentContextPrompt,
  loadVaultAgentContextFromLocalSlug,
  materializeVaultAgentContext,
} from '../src/vault-agent-contexts.js';

const tmpRoots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'od-vault-context-'));
  tmpRoots.push(root);
  return root;
}

async function writeFixture(root: string) {
  const slug = 'guizang-swiss-international';
  const designRoot = path.join(root, slug);
  const skillRoot = path.join(designRoot, 'skill');
  const sourceRoot = path.join(skillRoot, 'source');
  await mkdir(path.join(sourceRoot, 'references'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'assets'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'scripts'), { recursive: true });
  await mkdir(path.join(designRoot, 'execution'), { recursive: true });

  writeFileSync(
    path.join(designRoot, 'meta.json'),
    JSON.stringify(
      {
        slug,
        title: 'Guizang Swiss International',
        packageManifest: {
          packageType: 'presentation-system',
          secondaryTypes: ['visual-style-system'],
          skill: {
            entrypoint: path.join(designRoot, 'skill', 'SKILL.md'),
            referencePrompt: `Read ${path.join(designRoot, 'skill', 'source', 'SKILL.md')} before building.`,
            references: [
              path.join(designRoot, 'skill', 'references', 'checklist.md'),
              path.join(designRoot, 'skill', 'source', 'references'),
              path.join(designRoot, 'skill', 'source', 'scripts'),
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(designRoot, 'manifest.json'), '{"packageType":"presentation-system"}');
  writeFileSync(path.join(designRoot, 'capabilities.json'), '[{"id":"swiss-layout-lock"}]');
  writeFileSync(path.join(designRoot, 'PRODUCT.md'), '# Product\n\nSwiss deck system.');
  writeFileSync(path.join(designRoot, 'execution', 'DESIGN.md'), '# Execution Design\n\nUse grid.');
  writeFileSync(path.join(designRoot, 'STYLE_CARD.html'), '<main>Swiss style card</main>');
  writeFileSync(path.join(designRoot, 'anti-patterns.json'), '{"blockers":["rounded cards"]}');
  writeFileSync(path.join(designRoot, 'quality-gates.json'), '{"executionGates":[{"id":"read-source"}]}');
  writeFileSync(path.join(designRoot, 'open-slide-theme.md'), '# Theme\n\nSwiss locked mode.');
  writeFileSync(
    path.join(skillRoot, 'SKILL.md'),
    [
      '---',
      'name: dv-guizang-swiss-international',
      'description: Apply Swiss.',
      '---',
      '',
      `Read ${path.join(designRoot, 'skill', 'source', 'SKILL.md')}.`,
      `Use ${path.join(designRoot, 'skill', 'source', 'references')}.`,
      '',
    ].join('\n'),
  );
  await mkdir(path.join(skillRoot, 'references'), { recursive: true });
  writeFileSync(path.join(skillRoot, 'references', 'checklist.md'), '# Wrapper checklist');
  writeFileSync(path.join(sourceRoot, 'materialized.json'), '{"sourceCommit":"f6676c3f315e4cbf8abb41daa26377688a716a5f"}');
  writeFileSync(path.join(sourceRoot, 'SKILL.md'), '# Upstream Guizang\n\nRead `references/swiss-layout-lock.md`.');
  writeFileSync(path.join(sourceRoot, 'README.md'), '# Upstream README');
  writeFileSync(path.join(sourceRoot, 'references', 'swiss-layout-lock.md'), '# Swiss Layout Lock\n\nS01-S22 only.');
  writeFileSync(path.join(sourceRoot, 'references', 'layouts-swiss.md'), '# Layouts Swiss');
  writeFileSync(path.join(sourceRoot, 'references', 'themes-swiss.md'), '# Themes Swiss');
  writeFileSync(path.join(sourceRoot, 'references', 'image-prompts.md'), '# Image Prompts');
  writeFileSync(path.join(sourceRoot, 'references', 'checklist.md'), '# Source Checklist');
  writeFileSync(path.join(sourceRoot, 'assets', 'template-swiss.html'), '<!doctype html><title>Swiss</title>');
  writeFileSync(path.join(sourceRoot, 'scripts', 'validate-swiss-deck.mjs'), 'console.log("validator");');
}

async function writePromptContextFixture(root: string) {
  const slug = 'carrot-carrot-tech';
  const designRoot = path.join(root, slug);
  await mkdir(path.join(designRoot, 'execution'), { recursive: true });
  await mkdir(path.join(designRoot, 'previews'), { recursive: true });
  await mkdir(path.join(designRoot, 'assets', 'visual-journey'), { recursive: true });

  writeFileSync(
    path.join(designRoot, 'meta.json'),
    JSON.stringify(
      {
        slug,
        title: 'Carrot',
        packageType: 'website-style-system',
        summary: 'Source-derived web style system.',
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(designRoot, 'PRODUCT.md'), '# Product\n\nUse when matching Carrot.');
  writeFileSync(path.join(designRoot, 'execution', 'DESIGN.md'), '# Carrot DESIGN\n\nSTYLE_CARD.html is the minimum visual proof.');
  writeFileSync(path.join(designRoot, 'STYLE_CARD.html'), '<main data-style-card="carrot">Carrot visual specimen</main>');
  writeFileSync(path.join(designRoot, 'anti-patterns.json'), '{"antiPatterns":[{"rule":"Do not use card grid layouts"}]}');
  writeFileSync(path.join(designRoot, 'quality-gates.json'), '{"executionGates":[{"id":"match-style-card","required":true}]}');
  writeFileSync(path.join(designRoot, 'capabilities.json'), '[{"id":"multi-module-text-sample"}]');
  writeFileSync(path.join(designRoot, 'design.md'), '# Design\n\nHigh-contrast Carrot style.');
  writeFileSync(path.join(designRoot, 'open-slide-theme.md'), '# Theme\n\nNo entrance animations.');
  writeFileSync(path.join(designRoot, 'tokens.json'), '{"palette":{"accent":"#e7eb5d"}}');
  writeFileSync(path.join(designRoot, 'profile.json'), '{"archetype":"source-derived web style system"}');
  writeFileSync(path.join(designRoot, 'assets', 'visual-journey', 'load-viewport.jpg'), 'source screenshot');
  writeFileSync(path.join(designRoot, 'assets', 'hero-image-1.png'), 'source hero');
  writeFileSync(
    path.join(designRoot, 'previews', 'card.html'),
    [
      '<!doctype html><html><head>',
      '<style>',
      ':root { --dv-color-bg: #ffffff; --dv-duration-base: 220ms; }',
      'html, body { width: 800px; height: 500px; }',
      '.style-card { border-radius: 12px; }',
      '</style>',
      '<style>',
      ':root {',
      '  --dv-color-role-hero: #e7eb5d;',
      '  --dv-bg: var(--dv-color-role-hero);',
      '  --dv-radius-xs: 0px;',
      '  --dv-radius-card: var(--dv-radius-xs);',
      '  --dv-motion-reveal: var(--dv-duration-base);',
      '}',
      '.dv-rounded-card { border-radius: var(--dv-radius-card); }',
      '</style>',
      '</head><body></body></html>',
    ].join('\n'),
  );
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Design Vault agent contexts', () => {
  it('injects upstream source package files and Swiss validation references', async () => {
    const root = tempRoot();
    await writeFixture(root);

    const context = await loadVaultAgentContextFromLocalSlug('guizang-swiss-international', {
      designsRoot: root,
    });
    expect(context?.sourceSkillPath).toContain('skill/source/SKILL.md');
    expect(context?.sourceReferences?.some((file) => file.endsWith('swiss-layout-lock.md'))).toBe(true);

    const prompt = await buildVaultAgentContextPrompt(context);
    expect(prompt?.body).toContain('### Active upstream source package');
    expect(prompt?.body).toContain('source/reference/swiss-layout-lock.md');
    expect(prompt?.body).toContain('S01-S22 only.');
    expect(prompt?.body).toContain('template-swiss.html');
    expect(prompt?.body).toContain('validate-swiss-deck.mjs');
    expect(prompt?.body).not.toContain('source/scripts is not readable');
  });

  it('materializes active skills with a self-contained upstream source copy', async () => {
    const root = tempRoot();
    await writeFixture(root);
    const context = await loadVaultAgentContextFromLocalSlug('guizang-swiss-international', {
      designsRoot: root,
    });
    expect(context).toBeTruthy();

    const skillsDir = path.join(root, 'openppt-skills');
    const designSystemsDir = path.join(root, 'openppt-design-systems');
    const result = await materializeVaultAgentContext(context!, { skillsDir, designSystemsDir });
    expect(result.skillId).toBe('dv-guizang-swiss-international');

    const target = path.join(skillsDir, 'dv-guizang-swiss-international');
    expect(existsSync(path.join(target, 'source', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(target, 'source', 'references', 'swiss-layout-lock.md'))).toBe(true);
    expect(existsSync(path.join(target, 'source', 'assets', 'template-swiss.html'))).toBe(true);
    expect(existsSync(path.join(target, 'source', 'scripts', 'validate-swiss-deck.mjs'))).toBe(true);
    expect(existsSync(path.join(target, 'PRODUCT.md'))).toBe(true);
    expect(existsSync(path.join(target, 'quality-gates.json'))).toBe(true);

    const skillBody = readFileSync(path.join(target, 'SKILL.md'), 'utf8');
    expect(skillBody).toContain(path.join(target, 'source', 'SKILL.md'));
    expect(skillBody).not.toContain(path.join(root, 'guizang-swiss-international', 'skill', 'source', 'SKILL.md'));
  });

  it('includes execution fidelity files for prompt-context systems', async () => {
    const root = tempRoot();
    await writePromptContextFixture(root);

    const context = await loadVaultAgentContextFromLocalSlug('carrot-carrot-tech', {
      designsRoot: root,
    });
    expect(context?.kind).toBe('prompt-context');
    expect(context?.tokenStylesheet).toContain('--dv-radius-card: var(--dv-radius-xs)');
    expect(context?.tokenStylesheet).toContain('.dv-rounded-card');
    expect(context?.tokenStylesheet).not.toContain('width: 800px');
    expect(context?.sourceVisualAssets?.[0]).toContain('assets/visual-journey/load-viewport.jpg');

    const prompt = await buildVaultAgentContextPrompt(context);
    expect(prompt?.body).toContain('### Localized source visual assets');
    expect(prompt?.body).toContain('copy at least one representative source asset');
    expect(prompt?.body).toContain('assets/visual-journey/load-viewport.jpg');
    expect(prompt?.body).toContain('assets/hero-image-1.png');
    expect(prompt?.body).toContain('For SFA decks, the execution context and style card are not optional references');
    expect(prompt?.body).toContain('### execution/DESIGN.md');
    expect(prompt?.body).toContain('STYLE_CARD.html is the minimum visual proof');
    expect(prompt?.body).toContain('### STYLE_CARD.html');
    expect(prompt?.body).toContain('Carrot visual specimen');
    expect(prompt?.body).toContain('Do not use card grid layouts');
    expect(prompt?.body).toContain('match-style-card');
    expect(prompt?.filesRead).toContain(path.join(root, 'carrot-carrot-tech', 'STYLE_CARD.html'));
  });
});
