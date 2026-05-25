// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { splitOnQuestionForms, type QuestionForm } from '../../src/artifacts/question-form';
import { QuestionFormView } from '../../src/components/QuestionForm';
import type { VaultDesignMeta } from '../../src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockVaultDesigns = vi.hoisted<VaultDesignMeta[]>(() => [
  {
    slug: 'black-and-gray-minimalist-creative-portfolio-presentation',
    title: 'Black And Gray Minimalist Creative Portfolio Presentation',
    sourceUrl: 'https://canva.example/black-gray',
    sourceHost: 'canva.example',
    sourceMode: 'design-system-project',
    status: 'ready',
    summary: 'Minimal portfolio presentation system.',
    kind: 'skill-package',
    packageType: 'presentation-system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    designPath: '',
    openSlideThemePath: '',
    evidencePath: '',
    profilePath: '',
    assets: [],
    previews: { web: '', ppt: 'ppt.html', card: 'card.html' },
    tokens: {
      colors: { primary: '#111111', secondary: '#777777', surface: '#f5f3ee', text: '#111111' },
      typography: { families: { display: 'Playfair Display', primary: 'Inter' } },
    },
    profile: {
      confidence: 'medium',
      visualThesis: 'Minimal portfolio and gallery presentation system.',
      colorRoles: {
        brandPrimary: '#111111',
        brandSecondary: '#777777',
        background: '#f5f3ee',
        text: '#111111',
      },
    },
  },
  {
    slug: 'quinn-global-tax-law-international-tax-legal-advisory-firm-web',
    title: 'Quinn Global Tax Law',
    sourceUrl: 'https://quinn.example',
    sourceHost: 'quinn.example',
    sourceMode: 'url',
    status: 'ready',
    summary: 'Institutional editorial legal advisory style.',
    kind: 'prompt-context',
    packageType: 'website-style',
    tags: ['institutional-editorial'],
    previewImage: '/api/vault/designs/quinn-global-tax-law-international-tax-legal-advisory-firm-web/preview-image',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    designPath: '',
    openSlideThemePath: '',
    evidencePath: '',
    profilePath: '',
    assets: [],
    previews: { web: 'preview.html', ppt: '', card: 'card.html' },
    tokens: {
      colors: { primary: '#000000', secondary: '#e2d7cc', surface: '#f7f5ef', text: '#111827' },
      typography: { families: { display: 'Editorial Serif', primary: 'Inter' } },
    },
    profile: {
      confidence: 'high',
      visualThesis: 'Cross-border clarity with editorial contrast.',
      colorRoles: {
        brandPrimary: '#000000',
        brandSecondary: '#e2d7cc',
        background: '#f7f5ef',
        text: '#111827',
      },
      openSlideGuidance: {
        direction: 'Editorial split-page legal advisory composition.',
        coverApproach: 'Large serif claim with restrained brand blocks.',
        layoutApproach: ['split grid', 'large editorial type'],
        motionApproach: ['fadeUp'],
      },
    },
  },
  {
    slug: 'guizang-ppt-skill-test',
    title: 'guizang-ppt-skill',
    sourceUrl: 'https://github.com/example/guizang-ppt-skill',
    sourceHost: 'github.com',
    sourceMode: 'design-system-project',
    status: 'ready',
    summary: 'Presentation grammar skill package.',
    kind: 'skill-package',
    packageType: 'presentation-system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    designPath: '',
    openSlideThemePath: '',
    evidencePath: '',
    profilePath: '',
    assets: [],
    previews: { web: '', ppt: 'preview.html', card: 'card.html' },
    tokens: {
      colors: { primary: '#f5b700', secondary: '#111111', surface: '#f7f4ed', text: '#111111' },
      typography: { families: { display: 'IBM Plex Mono', primary: 'Inter' } },
    },
    profile: {
      confidence: 'medium',
      visualThesis: 'Magazine presentation grammar.',
      colorRoles: {
        brandPrimary: '#f5b700',
        brandSecondary: '#111111',
        background: '#f7f4ed',
        text: '#111111',
      },
    },
  },
  {
    slug: 'vercel-vercel-com',
    title: 'Vercel',
    sourceUrl: 'https://vercel.com',
    sourceHost: 'vercel.com',
    sourceMode: 'url',
    status: 'ready',
    summary: 'Dark developer platform system.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    designPath: '',
    openSlideThemePath: '',
    evidencePath: '',
    profilePath: '',
    assets: [],
    previews: { web: '', ppt: '', card: '' },
    tokens: {
      colors: { primary: '#ffffff', secondary: '#666666', surface: '#050505', text: '#f5f5f5' },
      typography: { families: { display: 'Space Grotesk', primary: 'Inter' } },
    },
    profile: {
      confidence: 'medium',
      visualThesis: 'Dark event / developer conference.',
      colorRoles: {
        brandPrimary: '#ffffff',
        brandSecondary: '#666666',
        background: '#050505',
        text: '#f5f5f5',
      },
    },
  },
  {
    slug: 'phantom-the-money-app-that-ll-take-you-places-phantom-com',
    title: 'Phantom: The money app that will take you places',
    sourceUrl: 'https://phantom.com',
    sourceHost: 'phantom.com',
    sourceMode: 'url',
    status: 'ready',
    summary: 'Warm product storytelling system.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    designPath: '',
    openSlideThemePath: '',
    evidencePath: '',
    profilePath: '',
    assets: [],
    previews: { web: '', ppt: '', card: '' },
    tokens: {
      colors: { primary: '#ab9ff2', secondary: '#111111', surface: '#f3ecff', text: '#3c315b' },
      typography: { families: { display: 'Inter', primary: 'Inter' } },
    },
    profile: {
      confidence: 'high',
      visualThesis: 'Consumer product clarity.',
      matchingRationale: ['Good for product-led narrative.'],
      colorRoles: {
        brandPrimary: '#ab9ff2',
        brandSecondary: '#111111',
        background: '#f3ecff',
        text: '#3c315b',
      },
    },
  },
]);

vi.mock('../../src/providers/registry', () => ({
  fetchVaultDesigns: vi.fn(async () => mockVaultDesigns),
}));

describe('QuestionFormView Vault template picker', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
  });

  it('lets the user browse all Vault templates and replaces the session answer', async () => {
    const form: QuestionForm = {
      id: 'vault-template',
      title: 'Choose a style template',
      questions: [
        {
          id: 'template',
          label: 'Recommended template',
          type: 'radio',
          required: true,
          defaultValue: 'Vercel | slug: vercel-vercel-com — Dark event / developer conference.',
          options: ['Vercel | slug: vercel-vercel-com — Dark event / developer conference.'],
        },
      ],
    };
    let submitted: Record<string, string | string[]> = {};

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive
          onSubmit={(_text, answers) => {
            submitted = answers;
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const browseButton = findButton('Browse all templates');
    expect(browseButton).toBeTruthy();
    expect(browseButton?.classList.contains('qf-vault-browse-card')).toBe(true);
    expect(document.querySelector('.qf-vault-options')?.contains(browseButton)).toBe(true);

    await act(async () => {
      browseButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('.qf-vault-modal')).toBeTruthy();

    const search = document.querySelector<HTMLInputElement>('.qf-vault-modal-search-input');
    expect(search).toBeTruthy();
    await act(async () => {
      search!.value = 'phantom';
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const phantomRow = Array.from(document.querySelectorAll<HTMLElement>('.qf-vault-modal-row'))
      .find((row) => row.textContent?.includes('Phantom: The money app'));
    expect(phantomRow).toBeTruthy();

    await act(async () => {
      phantomRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('.qf-vault-modal')).toBeFalsy();
    expect(document.querySelector('.qf-vault-options')?.textContent).toContain('Phantom: The money app');

    await act(async () => {
      findButton('Send answers')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(submitted.template).toContain('phantom-the-money-app-that-ll-take-you-places-phantom-com');
  });

  it('uses a canonical Vault style label even when the agent labels it like an image model', async () => {
    const form: QuestionForm = {
      id: 'vault-template',
      title: 'Image generation model',
      questions: [
        {
          id: 'template',
          label: 'Image generation model',
          type: 'radio',
          required: true,
          options: ['Vercel | slug: vercel-vercel-com — Dark event / developer conference.'],
        },
      ],
    };

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive
          onSubmit={() => undefined}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('.question-form-title')?.textContent).toBe(
      'Choose a design style reference template',
    );
    expect(document.querySelector('.qf-label')?.textContent).toContain(
      'Design style reference template',
    );
    expect(document.querySelector('.qf-label')?.textContent).not.toContain(
      'Image generation model',
    );
    expect(document.querySelector('.qf-vault-browse-card')).toBeTruthy();
  });

  it('renders slug-only style recommendations as Vault preview cards', async () => {
    const form: QuestionForm = {
      id: 'style-template-recommendation',
      title: '选一个风格模板',
      description: '下面这 3 个模板最适合。',
      questions: [
        {
          id: 'recommended',
          label: '推荐模板',
          type: 'radio',
          required: true,
          options: [
            'quinn-global-tax-law-international-tax-legal-advisory-firm-w',
            'phantom-the-money-app-that-ll-take-you-places-phantom-com',
            'guizang-ppt-skill-test',
            'let-the-agent-choose',
          ],
        },
      ],
    };

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive
          onSubmit={() => undefined}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const cards = Array.from(document.querySelectorAll<HTMLElement>('.qf-vault-card'));
    expect(cards).toHaveLength(3);
    expect(document.querySelectorAll('.qf-chip')).toHaveLength(0);
    expect(document.querySelector('.qf-vault-browse-card')?.textContent).toContain('Browse all templates');
    expect(document.querySelector('.qf-vault-agent-choice')?.textContent).toContain('Let the agent choose');
    expect(cards[0]?.textContent).toContain('Quinn Global Tax Law');
    expect(cards[0]?.querySelector('iframe')?.getAttribute('src')).toContain('/api/vault/designs/quinn-global-tax-law-international-tax-legal-advisory-firm-web/preview?kind=card');
    expect(cards[0]?.querySelector('iframe')?.getAttribute('src')).toContain('surface=library');
    expect(cards[0]?.querySelector('.qf-vault-preview-scaled')).toBeTruthy();
    expect(cards[1]?.textContent).toContain('Phantom');
    expect(cards[2]?.querySelector('iframe')?.getAttribute('src')).toContain('/api/vault/designs/guizang-ppt-skill-test/preview?kind=card');
    expect(cards[2]?.querySelector('iframe')?.getAttribute('src')).toContain('surface=library');
  });

  it('renders prose-inferred Vault recommendations as visual preview cards', async () => {
    const message = `收到，以下 2 套模板最匹配：

1. **Quinn Global Tax Law**
适合机构型叙事和克制版式。

2. **guizang-ppt-skill**
适合演示语法更强的方案。

<question-form id="vault-template" title="选择视觉模板">
{
  "description": "选一个最契合团队审美的：",
  "questions": [
    {
      "id": "template",
      "label": "模板",
      "type": "radio",
      "required": true,
      "options": []
    }
  ]
}
</question-form>`;
    const segment = splitOnQuestionForms(message).find((item) => item.kind === 'form');
    if (!segment || segment.kind !== 'form') throw new Error('expected parsed form');

    await act(async () => {
      root.render(
        <QuestionFormView
          form={segment.form}
          interactive
          onSubmit={() => undefined}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const cards = Array.from(document.querySelectorAll<HTMLElement>('.qf-vault-card'));
    expect(cards).toHaveLength(2);
    expect(document.querySelectorAll('.qf-chip')).toHaveLength(0);
    expect(cards[0]?.textContent).toContain('Quinn Global Tax Law');
    expect(cards[0]?.querySelector('iframe')?.getAttribute('src')).toContain(
      '/api/vault/designs/quinn-global-tax-law-international-tax-legal-advisory-firm-web/preview?kind=card',
    );
    expect(cards[0]?.querySelector('iframe')?.getAttribute('src')).toContain('surface=library');
    expect(cards[1]?.textContent).toContain('guizang-ppt-skill');
    expect(cards[1]?.querySelector('iframe')?.getAttribute('src')).toContain('/api/vault/designs/guizang-ppt-skill-test/preview?kind=card');
  });

  it('does not render unmatched prose options as fake Vault preview cards', async () => {
    const form: QuestionForm = {
      id: 'vault-template',
      title: '选择视觉模板',
      questions: [
        {
          id: 'template',
          label: '模板',
          type: 'radio',
          required: true,
          options: [
            'Black And Gray Minimalist Creative Portfolio Presentation',
            'Medium — headline + 3–5 bullet points + one visual',
            'Dense — diagrams, tables, and multi-section layouts',
          ],
        },
      ],
    };

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive
          onSubmit={() => undefined}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const cards = Array.from(document.querySelectorAll<HTMLElement>('.qf-vault-card'));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain('Black And Gray Minimalist Creative Portfolio Presentation');
    expect(document.querySelector('.qf-vault-options')?.textContent).not.toContain('Medium — headline');
    expect(document.querySelector('.qf-vault-options')?.textContent).not.toContain('Dense — diagrams');
    expect(cards[0]?.querySelector('iframe')?.getAttribute('src')).toContain(
      '/api/vault/designs/black-and-gray-minimalist-creative-portfolio-presentation/preview?kind=card',
    );
    expect(cards[0]?.querySelector('iframe')?.getAttribute('src')).toContain('surface=library');
  });

  it('keeps the all-template catalog available as read-only after submission', async () => {
    const form: QuestionForm = {
      id: 'style-template-recommendation',
      title: '选一个风格模板',
      questions: [
        {
          id: 'recommended',
          label: '推荐模板',
          type: 'radio',
          required: true,
          options: [
            'quinn-global-tax-law-international-tax-legal-advisory-firm-w',
            'phantom-the-money-app-that-ll-take-you-places-phantom-com',
            'guizang-ppt-skill-test',
          ],
        },
      ],
    };

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive={false}
          submittedAnswers={{ recommended: 'guizang-ppt-skill-test' }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const browseButton = findButton('Browse all templates');
    expect(browseButton).toBeTruthy();

    await act(async () => {
      browseButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('.qf-vault-modal')).toBeTruthy();
    expect(document.querySelector('.qf-vault-modal-head')?.textContent).toContain('read-only');
    expect(document.querySelectorAll('button.qf-vault-modal-row').length).toBeGreaterThan(0);
  });

  it('collapses answered Vault recommendations to the selected session card', async () => {
    const form: QuestionForm = {
      id: 'style-template-recommendation',
      title: '选一套视觉系统',
      questions: [
        {
          id: 'recommended',
          label: '视觉模板',
          type: 'radio',
          required: true,
          options: [
            'simon-holm-larsen-brand-designer-www-simonholm-studio-3',
            'black-and-gray-minimalist-creative-portfolio-presentation',
            'butt-studio-butt-studio-com',
          ],
        },
      ],
    };

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive={false}
          submittedAnswers={{ recommended: 'black-and-gray-minimalist-creative-portfolio-presentation' }}
          activeVaultTemplateSlug="phantom-the-money-app-that-ll-take-you-places-phantom-com"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelectorAll('.qf-vault-options .qf-vault-card')).toHaveLength(1);
    expect(document.querySelector('.qf-vault-options')?.textContent).toContain(
      'Black And Gray Minimalist Creative Portfolio Presentation',
    );
    expect(document.querySelector('.qf-vault-options')?.textContent).not.toContain('Phantom');
    expect(document.querySelector('.qf-vault-options')?.textContent).not.toContain('BUTT STUDIO');
    expect(findButton('Browse all templates')).toBeTruthy();
  });

  it('uses compact filters and embeds quality scores inside template rows', async () => {
    const form: QuestionForm = {
      id: 'style-template-recommendation',
      title: '选一个风格模板',
      questions: [
        {
          id: 'recommended',
          label: '推荐模板',
          type: 'radio',
          required: true,
          options: ['quinn-global-tax-law-international-tax-legal-advisory-firm-w'],
        },
      ],
    };

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive={false}
          submittedAnswers={{ recommended: 'quinn-global-tax-law-international-tax-legal-advisory-firm-w' }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const browseButton = findButton('Browse all templates');
    await act(async () => {
      browseButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('.qf-vault-modal-filterbar')).toBeTruthy();
    expect(document.querySelector('.qf-vault-modal-backdrop')?.parentElement).toBe(document.body);
    expect(document.querySelectorAll('.qf-vault-modal-filterbar .qf-vault-modal-select')).toHaveLength(4);
    const firstRow = document.querySelector('.qf-vault-modal-row');
    expect(firstRow?.querySelector('.qf-vault-modal-row-title-line .qf-vault-modal-row-score')).toBeTruthy();
    expect(firstRow?.children[0]?.classList.contains('qf-vault-modal-row-score')).toBe(false);
  });

  it('keeps read-only all-template browsing from overwriting the session template', async () => {
    const form: QuestionForm = {
      id: 'style-template-recommendation',
      title: '选一个风格模板',
      questions: [
        {
          id: 'recommended',
          label: '推荐模板',
          type: 'radio',
          required: true,
          options: ['guizang-ppt-skill-test'],
        },
      ],
    };
    const onVaultTemplateSelect = vi.fn();

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive={false}
          submittedAnswers={{ recommended: 'guizang-ppt-skill-test' }}
          activeVaultTemplateSlug="phantom-the-money-app-that-ll-take-you-places-phantom-com"
          onVaultTemplateSelect={onVaultTemplateSelect}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      findButton('Browse all templates')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const selectedRows = Array.from(document.querySelectorAll<HTMLElement>('.qf-vault-modal-row.selected'));
    expect(selectedRows).toHaveLength(1);
    expect(selectedRows[0]?.textContent).toContain('guizang-ppt-skill');
    expect(selectedRows[0]?.textContent).not.toContain('Phantom');

    const quinnRow = Array.from(document.querySelectorAll<HTMLElement>('.qf-vault-modal-row'))
      .find((row) => row.textContent?.includes('Quinn Global Tax Law'));
    expect(quinnRow).toBeTruthy();

    await act(async () => {
      quinnRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('.qf-vault-modal')).toBeTruthy();
    expect(onVaultTemplateSelect).not.toHaveBeenCalled();
    expect(document.querySelector('.qf-vault-options')?.textContent).toContain('guizang-ppt-skill');
    expect(document.querySelector('.qf-vault-options')?.textContent).not.toContain('Phantom');
  });

  it('does not show the all-template browse entry on unrelated empty radio questions', async () => {
    const form: QuestionForm = {
      id: 'quick-brief',
      title: '快速确认 — 30秒',
      description: '我会根据你的回答锁定内容方向并推荐视觉模板。',
      questions: [
        {
          id: 'audience',
          label: '这份PPT的受众是谁？',
          type: 'text',
          required: true,
        },
        {
          id: 'purpose',
          label: '核心目的是什么？',
          type: 'radio',
          required: true,
          options: [],
        },
        {
          id: 'template',
          label: '视觉模板',
          type: 'radio',
          required: true,
          options: [],
        },
        {
          id: 'language',
          label: '语言',
          type: 'radio',
          required: true,
          options: [],
        },
      ],
    };

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive
          onSubmit={() => undefined}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelectorAll('.qf-vault-browse-card')).toHaveLength(1);
    expect(document.querySelectorAll('.qf-vault-options')).toHaveLength(1);
    expect(document.querySelectorAll('.qf-input')).toHaveLength(3);
    expect(document.querySelector('.qf-vault-browse-card')?.textContent).toContain('Browse all templates');
  });

  it('does not relabel a purpose question as a Vault template when bad template options leak in', async () => {
    const form: QuestionForm = {
      id: 'discovery',
      title: 'Quick brief — 30 seconds',
      description: '样式会在下一步从 Design Vault 模板里选。先确认内容策略。',
      questions: [
        {
          id: 'purpose',
          label: '核心目的是什么？',
          type: 'radio',
          required: true,
          options: [
            'Dash Digital Studio | Engage. Connect. | slug: dash-digital-studio-engage-connect-dashdigital-studio-2 — Monochrome editorial studio aesthetic.',
          ],
        },
        {
          id: 'template',
          label: '设计风格参考模板',
          type: 'radio',
          required: true,
          options: ['Vercel | slug: vercel-vercel-com — Dark developer platform system.'],
        },
      ],
    };

    await act(async () => {
      root.render(
        <QuestionFormView
          form={form}
          interactive
          onSubmit={() => undefined}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const labels = Array.from(document.querySelectorAll<HTMLElement>('.qf-label'));
    expect(labels[0]?.textContent).toContain('核心目的是什么？');
    expect(labels[1]?.textContent).toContain('Design style reference template');
    expect(document.querySelectorAll('.qf-input')).toHaveLength(1);
    expect(document.querySelectorAll('.qf-vault-options')).toHaveLength(1);
    expect(document.querySelector('.qf-vault-options')?.textContent).toContain('Vercel');
    expect(document.querySelector('.qf-vault-options')?.textContent).not.toContain('Dash Digital Studio');
  });

  it('keeps purpose answers separate from Vault template picks when agent repeats ids', async () => {
    const message = `<question-form id="discovery" title="Quick brief — 30 seconds">
{
  "questions": [
    {
      "id": "purpose",
      "label": "核心目的是什么？",
      "type": "text",
      "required": true
    },
    {
      "id": "purpose",
      "label": "设计风格参考模板",
      "type": "radio",
      "required": true,
      "options": [
        "Vercel | slug: vercel-vercel-com — Dark developer platform system."
      ]
    }
  ],
  "submitLabel": "Send answers"
}
</question-form>`;
    const segment = splitOnQuestionForms(message).find((item) => item.kind === 'form');
    if (!segment || segment.kind !== 'form') throw new Error('expected parsed form');
    let submittedText = '';
    let submitted: Record<string, string | string[]> = {};

    await act(async () => {
      root.render(
        <QuestionFormView
          form={segment.form}
          interactive
          onSubmit={(text, answers) => {
            submittedText = text;
            submitted = answers;
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const purposeInput = document.querySelector<HTMLInputElement>('.qf-input');
    expect(purposeInput).toBeTruthy();
    await act(async () => {
      setInputValue(purposeInput!, '统一内部知识库架构共识');
    });

    const templateInput = document.querySelector<HTMLInputElement>('.qf-vault-card input');
    expect(templateInput).toBeTruthy();
    await act(async () => {
      templateInput!.click();
      await Promise.resolve();
    });

    await act(async () => {
      findButton('Send answers')!.click();
    });

    expect(submitted.purpose).toBe('统一内部知识库架构共识');
    expect(submitted['purpose-2']).toContain('vercel-vercel-com');
    expect(submittedText).toContain('- 核心目的是什么？: 统一内部知识库架构共识');
    expect(submittedText).toContain('- 设计风格参考模板: Vercel | slug: vercel-vercel-com');
    expect(submittedText).not.toContain('- 核心目的是什么？: Vercel | slug: vercel-vercel-com');
  });
});

function findButton(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.includes(label)) ?? null;
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
