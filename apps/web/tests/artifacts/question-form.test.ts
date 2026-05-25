import { describe, expect, it } from 'vitest';

import { splitOnQuestionForms } from '../../src/artifacts/question-form';

describe('question-form parser', () => {
  it('hydrates empty Vault template options from preceding recommendations', () => {
    const message = `收到，以下 3 套模板最匹配你的需求：

1. **Black And Gray Minimalist Creative Portfolio Presentation**
这是一套“机构感冷静”的画廊式演示系统。

2. **Guizang Swiss International**
严格的瑞士国际主义网格，适合事实、产品、数据。

3. **Guizang Electronic Ink Magazine**
纸墨色调的编辑式演示系统，适合更有温度的场景。

<question-form id="vault-template" title="选择视觉模板">
{
  "description": "以下 3 套模板都匹配你的需求，选一个最契合团队审美的：",
  "questions": [
    {
      "id": "template",
      "label": "模板",
      "type": "radio",
      "required": true,
      "options": []
    }
  ],
  "submitLabel": "发送答案"
}
</question-form>`;

    const form = splitOnQuestionForms(message).find((segment) => segment.kind === 'form');

    expect(form?.kind).toBe('form');
    const options = form?.kind === 'form' ? form.form.questions[0]?.options : [];
    expect(options?.map((option) => option.split(' — ')[0])).toEqual([
      'Black And Gray Minimalist Creative Portfolio Presentation',
      'Guizang Swiss International',
      'Guizang Electronic Ink Magazine',
    ]);
    expect(options?.[0]).toContain('机构感冷静');
  });

  it('does not hydrate every empty radio when the form description mentions visual templates', () => {
    const message = `收到，以下 2 套模板最匹配：

1. **Black And Gray Minimalist Creative Portfolio Presentation**
这是一套“机构感冷静”的画廊式演示系统。

2. **Guizang Swiss International**
严格的瑞士国际主义网格。

<question-form id="quick-brief" title="快速确认 — 30秒">
{
  "description": "我会根据你的回答锁定内容方向并推荐视觉模板。",
  "questions": [
    {
      "id": "audience",
      "label": "这份PPT的受众是谁？",
      "type": "text",
      "required": true
    },
    {
      "id": "purpose",
      "label": "核心目的是什么？",
      "type": "radio",
      "required": true,
      "options": []
    },
    {
      "id": "template",
      "label": "视觉模板",
      "type": "radio",
      "required": true,
      "options": []
    },
    {
      "id": "language",
      "label": "语言",
      "type": "radio",
      "required": true,
      "options": []
    }
  ]
}
</question-form>`;

    const form = splitOnQuestionForms(message).find((segment) => segment.kind === 'form');

    expect(form?.kind).toBe('form');
    if (!form || form.kind !== 'form') throw new Error('expected parsed form');
    expect(form.form.questions.find((q) => q.id === 'purpose')?.options).toEqual([]);
    expect(form.form.questions.find((q) => q.id === 'language')?.options).toEqual([]);
    expect(form.form.questions.find((q) => q.id === 'template')?.options?.map((option) => option.split(' — ')[0])).toEqual([
      'Black And Gray Minimalist Creative Portfolio Presentation',
      'Guizang Swiss International',
    ]);
  });

  it('deduplicates repeated question ids before answers are keyed by id', () => {
    const message = `<question-form id="quick-brief" title="快速确认">
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
        "Dash Digital Studio | Engage. Connect. | slug: dash-digital-studio-engage-connect-dashdigital-studio-2 — Monochrome editorial studio aesthetic."
      ]
    }
  ]
}
</question-form>`;

    const form = splitOnQuestionForms(message).find((segment) => segment.kind === 'form');

    expect(form?.kind).toBe('form');
    if (!form || form.kind !== 'form') throw new Error('expected parsed form');
    expect(form.form.questions.map((q) => q.id)).toEqual(['purpose', 'purpose-2']);
    expect(form.form.questions.map((q) => q.label)).toEqual([
      '核心目的是什么？',
      '设计风格参考模板',
    ]);
  });
});
