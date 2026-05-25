import { describe, expect, it } from 'vitest';

import {
  OPENPPT_MEDIA_STYLE_CONTEXT_MARKER,
  buildOpenPptMediaStyleContext,
  enhanceOpenPptMediaPrompt,
  summarizeVaultContextForMediaPrompt,
} from '../src/openppt-media-prompts.js';

describe('OpenPPT media prompt enhancement', () => {
  const redisContext = [
    '# Redis Agency DESIGN',
    '',
    '## Visual Thesis',
    '',
    'High-contrast dark surface with restrained warm accent, Swiss typographic precision, fixed navigation, and case-study-forward portfolio density.',
    '',
    '## Layout Grammar',
    '',
    '- Hero image area with a gradient overlay.',
    '- Bottom case study strip with dense image tiles.',
    '- Case label, CTA, page indicator, and corner accent line.',
    '',
    '## Motion And Interaction',
    '',
    '- Hover image opacity and scale transitions around 150-250ms.',
  ].join('\n');

  it('extracts compact visual anchors from Vault context', () => {
    const summary = summarizeVaultContextForMediaPrompt(redisContext);

    expect(summary.join('\n')).toContain('Visual Thesis');
    expect(summary.join('\n')).toContain('case-study-forward portfolio density');
    expect(summary.join('\n')).toContain('Bottom case study strip');
    expect(summary.join('\n')).toContain('Hover image opacity');
  });

  it('builds a provider-facing style context from metadata and Vault context', () => {
    const lines = buildOpenPptMediaStyleContext({
      surface: 'image',
      designSystemId: 'dv-redis-agency-redis-agency',
      projectMetadata: {
        kind: 'deck',
        vaultTemplate: {
          slug: 'redis-agency-redis-agency',
          title: 'Redis Agency',
          visualThesis: 'Case-study-forward portfolio density.',
          mediaPromptGrammar: ['hero image crop', 'bottom cases strip', 'chrome-aware captions'],
          colorRoles: {
            background: '#000000',
            text: '#ffffff',
            brandPrimary: '#f84f2e',
          },
          typographyRoles: {
            body: 'Suisse bp intl',
            mono: 'monospace',
          },
          openSlideGuidance: {
            layoutApproach: ['fixed navigation', 'bottom cases strip'],
            motionApproach: ['source-observed 150-250ms hover feedback'],
          },
        },
      },
      vaultAgentContextBody: redisContext,
    });

    const text = lines.join('\n');
    expect(text).toContain(OPENPPT_MEDIA_STYLE_CONTEXT_MARKER);
    expect(text).toContain('Redis Agency');
    expect(text).toContain('primary #f84f2e');
    expect(text).toContain('hero image crop');
    expect(text).toContain('fixed navigation');
    expect(text).toContain('slot-first media rule');
    expect(text).toContain('crop-safety hard rule');
    expect(text).toContain('No half objects');
    expect(text).toContain('information-graphic rule');
    expect(text).toContain('container dimensions or CSS size');
    expect(text).toContain('asset boundary rule');
    expect(text).toContain('image-language transfer');
    expect(text).toContain('Avoid generic cyber glow');
  });

  it('appends Vault style context to deck image prompts before dispatch', () => {
    const prompt = enhanceOpenPptMediaPrompt({
      surface: 'image',
      prompt: 'Generate a workflow pipeline image for page 3.',
      output: 'slides/main-deck/assets/workflow-pipeline.png',
      designSystemId: 'dv-redis-agency-redis-agency',
      projectMetadata: {
        kind: 'deck',
        deckMedia: { enabled: true, required: true },
        vaultTemplate: {
          slug: 'redis-agency-redis-agency',
          title: 'Redis Agency',
          visualThesis: 'Case-study-forward portfolio density.',
        },
      },
      vaultAgentContextBody: redisContext,
    });

    expect(prompt).toContain('Generate a workflow pipeline image for page 3.');
    expect(prompt).toContain(OPENPPT_MEDIA_STYLE_CONTEXT_MARKER);
    expect(prompt).toContain('case-study-forward portfolio density');
    expect(prompt).toContain('diagram/process rule');
    expect(prompt).toContain('slides/main-deck/assets/workflow-pipeline.png');
  });

  it('always appends deck crop-safety rules even without Vault context', () => {
    const prompt = enhanceOpenPptMediaPrompt({
      surface: 'image',
      prompt: 'Generate a process diagram for page 5.',
      output: 'slides/main-deck/assets/process-diagram.png',
      projectMetadata: {
        kind: 'deck',
        deckMedia: { enabled: true, required: true },
      },
    });

    expect(prompt).toContain('Generate a process diagram for page 5.');
    expect(prompt).toContain(OPENPPT_MEDIA_STYLE_CONTEXT_MARKER);
    expect(prompt).toContain('not resolved; use the slide design system and Media Slot Plan');
    expect(prompt).toContain('crop-safety hard rule');
    expect(prompt).toContain('No half objects');
    expect(prompt).toContain('object-fit: contain');
  });

  it('does not alter non-image or non-deck media prompts', () => {
    expect(
      enhanceOpenPptMediaPrompt({
        surface: 'video',
        prompt: 'Make a short video.',
        projectMetadata: { kind: 'deck' },
        designSystemId: 'dv-redis-agency-redis-agency',
        vaultAgentContextBody: redisContext,
      }),
    ).toBe('Make a short video.');

    expect(
      enhanceOpenPptMediaPrompt({
        surface: 'image',
        prompt: 'Make an image.',
        projectMetadata: { kind: 'image' },
        designSystemId: 'dv-redis-agency-redis-agency',
        vaultAgentContextBody: redisContext,
      }),
    ).toBe('Make an image.');
  });

  it('does not append the style context twice', () => {
    const existing = [
      'Generate an image.',
      '',
      `${OPENPPT_MEDIA_STYLE_CONTEXT_MARKER}:`,
      '- active Vault design system: Redis Agency',
    ].join('\n');

    expect(
      enhanceOpenPptMediaPrompt({
        surface: 'image',
        prompt: existing,
        projectMetadata: { kind: 'deck' },
        designSystemId: 'dv-redis-agency-redis-agency',
        vaultAgentContextBody: redisContext,
      }),
    ).toBe(existing);
  });
});
