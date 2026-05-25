import { describe, expect, it } from 'vitest';

import { buildVaultTemplateMetadata } from '../../src/components/NewProjectPanel';
import type { VaultDesignMeta } from '../../src/types';

describe('buildVaultTemplateMetadata', () => {
  it('passes Design Vault componentMotionRecipes into project metadata', () => {
    const design: VaultDesignMeta = {
      slug: 'motion-template',
      title: 'Motion Template',
      sourceUrl: 'https://example.com',
      sourceHost: 'example.com',
      sourceMode: 'url',
      status: 'ready',
      summary: 'Motion-aware Design Vault template.',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      designPath: '/vault/motion/design.md',
      openSlideThemePath: '/vault/motion/open-slide-theme.md',
      evidencePath: '/vault/motion/evidence.json',
      profilePath: '/vault/motion/profile.json',
      assets: [],
      previews: { web: 'web.html', ppt: 'ppt.html' },
      profile: {
        confidence: 'high',
        typographyRoles: { display: 'ABC Display', body: 'Inter' },
        openSlideGuidance: {
          direction: 'Use component motion from the source.',
          coverApproach: 'Animated title reveal.',
          layoutApproach: ['product grid'],
          motionApproach: ['quiet reveal'],
        },
        componentMotionRecipes: [
          {
            id: 'cta-hover-scale',
            component: 'CTA Button',
            role: 'primary action',
            trigger: 'hover',
            statePair: 'rest -> hover',
            properties: ['scale', 'opacity'],
            timing: {
              duration: '220ms',
              easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
            },
            choreography: ['Scale the primary CTA only.'],
            cssHint: 'transform: scale(1.02)',
            pptAdapter: ['Use scale-pop emphasis.'],
            evidence: ['css:.button:hover'],
            confidence: 'high',
          },
        ],
      },
    };

    const metadata = buildVaultTemplateMetadata(design);

    expect(metadata?.componentMotionRecipes).toHaveLength(1);
    expect(metadata?.componentMotionRecipes?.[0]).toMatchObject({
      id: 'cta-hover-scale',
      component: 'CTA Button',
      pptAdapter: ['Use scale-pop emphasis.'],
    });
    expect(metadata?.typographyRoles?.display).toBe('ABC Display');
  });
});
