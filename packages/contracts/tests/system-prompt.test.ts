import { describe, expect, it } from 'vitest';

import { composeSystemPrompt } from '../src/prompts/system';

describe('composeSystemPrompt Design Vault motion recipes', () => {
  it('renders vaultComponentMotionRecipes and OpenPPT motion usage rules', () => {
    const prompt = composeSystemPrompt({
      skillMode: 'deck',
      metadata: {
        kind: 'deck',
        speakerNotes: false,
        vaultTemplate: {
          slug: 'motion-vault',
          title: 'Motion Vault',
          sourceUrl: 'https://example.com',
          sourceHost: 'example.com',
          componentMotionRecipes: [
            {
              id: 'nav-slide-enter',
              component: 'Nav',
              role: 'persistent chrome',
              trigger: 'slide-enter',
              statePair: 'hidden -> visible',
              properties: ['opacity', 'transform'],
              timing: {
                duration: '420ms',
                easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
                delay: '80ms',
              },
              choreography: ['Reveal nav after title.'],
              cssHint: 'animation: fade-up 420ms both',
              pptAdapter: ['Map to fade/fly-in entrance.'],
              evidence: ['css:.nav'],
              confidence: 'high',
            },
          ],
        },
      },
    });

    expect(prompt).toContain('### vaultComponentMotionRecipes');
    expect(prompt).toContain('id=nav-slide-enter');
    expect(prompt).toContain('component=Nav');
    expect(prompt).toContain('duration 420ms');
    expect(prompt).toContain('MotionStyles');
    expect(prompt).toContain('motionFromRecipe');
    expect(prompt).toContain('data-osd-motion-id');
    expect(prompt).toContain('prefers-reduced-motion');
    expect(prompt).toContain('Motion Choreography Map');
    expect(prompt).toContain('Motion Coverage Gate');
    expect(prompt).toContain('60% threshold');
    expect(prompt).toContain('## Vault Token Contract');
    expect(prompt).toContain('## Vault Source Fidelity Contract');
    expect(prompt).toContain('var(--dv-motion-reveal)');
    expect(prompt).toContain('Hardcoded hex, ms, or px values');
    expect(prompt).toContain('source-recognition cover');
    expect(prompt).toContain('Media Slot Plan');
    expect(prompt).toContain('planned media-slot fit');
    expect(prompt).toContain('Media Crop Gate');
    expect(prompt).toContain('object-fit: contain');
    expect(prompt).toContain('Design style reference template');
    expect(prompt).toContain('never label this field "image generation model"');
  });

  it('allows explicit pending deck media without assuming gpt-image-2', () => {
    const prompt = composeSystemPrompt({
      skillMode: 'deck',
      metadata: {
        kind: 'deck',
        speakerNotes: false,
        deckMedia: {
          enabled: true,
          required: true,
          imageAspect: '16:9',
        },
      },
    });

    expect(prompt).toContain('**deckMediaImageModel**: (not configured - do not assume a default image model)');
    expect(prompt).not.toContain('**deckMediaImageModel**: gpt-image-2');
    expect(prompt).toMatch(/no generic\s+default image model is implied/);
    expect(prompt).toContain('do **not** call');
    expect(prompt).toContain('The CLI requires');
    expect(prompt).toContain('Never attempt to "test" media generation by omitting `--model`');
    expect(prompt).toContain('data-openppt-media-status="pending"');
    expect(prompt).toContain('needs media replacement');
  });
});
