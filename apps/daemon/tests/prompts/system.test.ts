import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { composeSystemPrompt } from '../../src/prompts/system.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');
const liveArtifactRoot = path.join(repoRoot, 'skills/live-artifact');
const liveArtifactSkillPath = path.join(repoRoot, 'skills/live-artifact/SKILL.md');
const liveArtifactSkillMarkdown = readFileSync(liveArtifactSkillPath, 'utf8');
const liveArtifactSkillBody = [
  `> **Skill root (absolute):** \`${liveArtifactRoot}\``,
  '>',
  '> This skill ships side files alongside `SKILL.md`. When the workflow',
  '> below references relative paths such as `assets/template.html` or',
  '> `references/layouts.md`, resolve them against the skill root above and',
  '> open them via their full absolute path.',
  '>',
  '> Known side files in this skill: `references/artifact-schema.md`, `references/connector-policy.md`, `references/refresh-contract.md`.',
  '',
  '',
  liveArtifactSkillMarkdown.replace(/^---[\s\S]*?---\n\n/, '').trim(),
].join('\n');

describe('composeSystemPrompt', () => {
  it('injects live-artifact skill guidance and metadata intent', () => {
    const prompt = composeSystemPrompt({
      skillName: 'live-artifact',
      skillMode: 'prototype',
      skillBody: liveArtifactSkillBody,
      metadata: {
        kind: 'prototype',
        intent: 'live-artifact',
      } as any,
    });

    expect(prompt).toContain('## Active skill — live-artifact');
    expect(prompt).toContain(`> **Skill root (absolute):** \`${liveArtifactRoot}\``);
    expect(prompt).toContain('**Pre-flight (do this before any other tool):**');
    expect(prompt).toContain('`references/artifact-schema.md`');
    expect(prompt).toContain('`references/connector-policy.md`');
    expect(prompt).toContain('`references/refresh-contract.md`');
    expect(prompt).toContain('The wrapper reads injected `OD_NODE_BIN`, `OD_BIN`, `OD_DAEMON_URL`, and `OD_TOOL_TOKEN`');
    expect(prompt).toContain('Do not include or invent `projectId`; the daemon derives project/run scope from the token.');
    expect(prompt).toContain('"$OD_NODE_BIN" "$OD_BIN" tools live-artifacts create --input artifact.json');
    expect(prompt).toContain('if the user names a connector/source (for example Notion)');
    expect(prompt).toContain('list connectors before asking where the data comes from');
    expect(prompt).toContain('a connected `notion` connector plus a user brief that names Notion is enough to start with `notion.notion_search`');
    expect(prompt).toContain('Prefer the `live-artifact` skill workflow when available');
    expect(prompt).toContain('The first output should be a live artifact/dashboard/report');
  });

  it('locks Vault template style and uses the SFA deck contract for deck projects', () => {
    const prompt = composeSystemPrompt({
      skillName: 'openppt-deck',
      skillMode: 'deck',
      skillBody: 'Edit slides/<slideId>/index.tsx directly.',
      metadata: {
        kind: 'deck',
        speakerNotes: false,
        slideId: 'main-deck',
        slideWorkspace: 'slides',
        vaultTemplate: {
          slug: 'gt-mechanik',
          title: 'GT Mechanik',
          sourceHost: 'gt-mechanik.com',
          sourceUrl: 'https://gt-mechanik.com',
          archetype: 'type foundry / variable font specimen',
          visualThesis: 'Use huge type specimens and a mint engineering grid.',
          colorRoles: {
            background: '#f9f9f7',
            text: '#0b6c00',
            brandPrimary: '#929b1a',
            brandSecondary: '#cce3da',
          },
          openSlideGuidance: {
            direction: 'Make it feel like a type specimen.',
            coverApproach: 'Huge GT Mechanik sample text.',
            layoutApproach: ['mint grid', 'axis controls'],
            motionApproach: ['light fade only'],
          },
          openSlideThemePath: '/tmp/gt-mechanik/open-slide-theme.md',
        },
      } as any,
      vaultTemplateBody: '# GT Mechanik theme\n\nUse mint grid and type tester controls.',
      vaultAgentContextBody: '# GT Mechanik full context\n\nSTYLE_CARD.html is the visual target.',
    });

    expect(prompt).toContain('**vaultTemplate**: GT Mechanik');
    expect(prompt).toContain('**visual-style status**: LOCKED by the Vault template');
    expect(prompt).toContain('Do not ask the user to confirm visual tone');
    expect(prompt).toContain('STYLE_CARD.html is the visual target.');
    expect(prompt).not.toContain('Use mint grid and type tester controls.');
    expect(prompt).toContain('Pre-generation Design Vault transfer plan');
    expect(prompt).toContain('page archetype map');
    expect(prompt).toContain('# Slides from Anything Deck Contract');
    expect(prompt).toContain('Motion is Vault-first');
    expect(prompt).toContain('Motion Choreography Map');
    expect(prompt).toContain('Motion Coverage Gate');
    expect(prompt).toContain('60% threshold');
    expect(prompt).toContain('## Vault Token Contract');
    expect(prompt).toContain('## Vault Source Fidelity Contract');
    expect(prompt).toContain('var(--dv-color-role-hero)');
    expect(prompt).toContain('DO NOT substitute generic 150/220/320ms defaults');
    expect(prompt).toContain('Hardcoded hex, ms, or px values');
    expect(prompt).toContain('source-recognition cover');
    expect(prompt).toContain('Media-led templates are not presentation-ready as all-text decks.');
    expect(prompt).toContain('Deck Director Plan');
    expect(prompt).toContain('Presentation Design Contract');
    expect(prompt).toContain('Media Slot Plan');
    expect(prompt).toContain('planned media-slot fit');
    expect(prompt).toContain('Media Crop Gate');
    expect(prompt).toContain('object-fit: contain');
    expect(prompt).toContain('Slide Quality Critic');
    expect(prompt).toContain('Cross-deck Review');
    expect(prompt).toContain('Design style reference template');
    expect(prompt).toContain('never label this field "image generation model"');
    expect(prompt).toContain('Presentation-ready');
    expect(prompt).toContain('motion coverage');
    expect(prompt).toContain('Never say "complete", "ready for preview", or "ready for your review" based only on page count or asset existence.');
    expect(prompt).not.toContain('# Slide deck — fixed framework');
  });

  it('allows explicit pending deck media without assuming a default image model', () => {
    const prompt = composeSystemPrompt({
      skillName: 'openppt-deck',
      skillMode: 'deck',
      skillBody: 'Edit slides/<slideId>/index.tsx directly.',
      metadata: {
        kind: 'deck',
        speakerNotes: false,
        slideId: 'main-deck',
        slideWorkspace: 'slides',
        deckMedia: {
          enabled: true,
          required: true,
          imageAspect: '16:9',
        },
      } as any,
    });

    expect(prompt).toContain('**deckMediaImageModel**: (not configured - do not assume a default image model)');
    expect(prompt).not.toContain('**deckMediaImageModel**: gpt-image-2');
    expect(prompt).toMatch(/no generic\s+default image model is implied/);
    expect(prompt).toContain('do **not** call');
    expect(prompt).toContain('The CLI requires');
    expect(prompt).toContain('Never attempt to "test" media generation by omitting `--model`');
    expect(prompt).toContain('data-openppt-media-status="pending"');
    expect(prompt).toContain('needs media replacement');
    expect(prompt).toMatch(/Only try another model[\s\S]*user selects it\./);
  });

  it('locks chat-selected Design Vault systems before generation', () => {
    const prompt = composeSystemPrompt({
      skillName: 'openppt-deck',
      skillMode: 'deck',
      skillBody: 'Edit slides/<slideId>/index.tsx directly.',
      designSystemTitle: 'Redis Agency',
      designSystemBody: '# Redis Agency\n\nUse black surface, case-study density, and warm accent.',
      metadata: {
        kind: 'deck',
        speakerNotes: false,
        slideId: 'main-deck',
        slideWorkspace: 'slides',
      } as any,
      vaultAgentContextBody: [
        '# Redis Agency full context',
        '',
        'STYLE_CARD.html is the visual target.',
        'Use case-study strip, fixed navigation, and source image treatment.',
      ].join('\n'),
    });

    expect(prompt).toContain('Design-system transfer protocol');
    expect(prompt).toContain('translate the active design system into a project-specific visual plan');
    expect(prompt).toContain('**visual-style status**: LOCKED by the active Design Vault design system');
    expect(prompt).toContain('STYLE_CARD.html is the visual target.');
    expect(prompt).toContain('Pre-generation Design Vault transfer plan');
    expect(prompt).toContain('media slot plan');
    expect(prompt).toContain('media dispatch rule');
    expect(prompt).toContain('SFA media prompt style context');
    expect(prompt).not.toContain('**visual-style status**: DEFERRED TO CHAT');
  });

  it('defers deck style selection to chat and exposes Vault catalog recommendations', () => {
    const prompt = composeSystemPrompt({
      skillName: 'openppt-deck',
      skillMode: 'deck',
      skillBody: 'Edit slides/<slideId>/index.tsx directly.',
      metadata: {
        kind: 'deck',
        speakerNotes: false,
        slideId: 'main-deck',
        slideWorkspace: 'slides',
      } as any,
      vaultCatalogBody: [
        '- 1. GT Mechanik | slug: gt-mechanik | useCases: product_demo, keynote | audienceFit: developers | visualThesis: huge type specimens',
        '- 2. Vercel | slug: vercel | useCases: developer_conference | audienceFit: developers, executives | visualThesis: dark event keynote',
      ].join('\n'),
    });

    expect(prompt).toContain('**visual-style status**: DEFERRED TO CHAT');
    expect(prompt).toContain('### Available Design Vault style templates');
    expect(prompt).toContain('recommend 2-3 templates');
    expect(prompt).toContain('GT Mechanik');
    expect(prompt).toContain('slug: gt-mechanik');
    expect(prompt).toContain('SFA deck branch — Vault catalog matching');
    expect(prompt).toContain('# Slides from Anything Deck Contract');
    expect(prompt).toContain('Status language is strict');
    expect(prompt).toContain('Generated');
    expect(prompt).toContain('Renderable');
    expect(prompt).toContain('Assets verified');
    expect(prompt).toContain('Presentation-ready');
    expect(prompt).toContain('Motion Coverage Gate');
  });

  it('preflights Design Vault upstream source files for Swiss deck skills', () => {
    const prompt = composeSystemPrompt({
      skillName: 'dv-guizang-swiss-international',
      skillMode: 'deck',
      skillBody: [
        '# dv-guizang-swiss-international',
        'Read `/tmp/skills/dv-guizang-swiss-international/source/SKILL.md`.',
        'Use `/tmp/skills/dv-guizang-swiss-international/source/references`.',
        'Use `/tmp/skills/dv-guizang-swiss-international/source/assets`.',
        'Use `/tmp/skills/dv-guizang-swiss-international/source/scripts`.',
      ].join('\n'),
      metadata: {
        kind: 'deck',
        speakerNotes: false,
      } as any,
    });

    expect(prompt).toContain('**Pre-flight (do this before any other tool):**');
    expect(prompt).toContain('`source/SKILL.md`');
    expect(prompt).toContain('`source/references/swiss-layout-lock.md`');
    expect(prompt).toContain('`source/references/image-prompts.md`');
    expect(prompt).toContain('`source/assets/template-swiss.html`');
    expect(prompt).toContain('`source/scripts/validate-swiss-deck.mjs`');
    expect(prompt).toContain('`source/` is the upstream source of truth');
    expect(prompt).toContain('# Slides from Anything Deck Contract');
    expect(prompt).not.toContain('# Slide deck — fixed framework');
  });
});
