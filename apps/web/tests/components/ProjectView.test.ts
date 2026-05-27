import { describe, expect, it } from 'vitest';

import {
  deckMediaFromPrompt,
  deckMediaImageEnvironments,
  deckMediaImageModelChoice,
  resolveDeckMediaIntentPrompt,
  shouldAutoCollapseChatForOpenSlideInspect,
} from '../../src/components/ProjectView';

describe('ProjectView deck media intent', () => {
  it('treats svg/image visual-aid wording as generated deck media intent', () => {
    const deckMedia = deckMediaFromPrompt(
      '按照文档介绍这个底层原子能力干啥的。重要的页面创建 svg/image 进行插入辅助描述',
    );

    expect(deckMedia).toMatchObject({
      enabled: true,
      required: true,
      imageAspect: '16:9',
      source: 'chat',
    });
    expect(deckMedia?.imageModel).toBeUndefined();
  });

  it('only sets a deck media image model from explicit prompt text or existing configuration', () => {
    expect(deckMediaFromPrompt('关键页面用 gpt-image-1 生成配图')?.imageModel).toBe('gpt-image-1');
    expect(deckMediaFromPrompt('关键页面用 flux-1.1-pro 生成配图')?.imageModel).toBe('flux-1.1-pro');
    expect(
      deckMediaFromPrompt('关键页面生成配图', {
        enabled: true,
        required: true,
        imageModel: 'imagen-4',
      })?.imageModel,
    ).toBe('imagen-4');
  });

  it('extracts selected visual-aid pages from discovery form answers', () => {
    const deckMedia = deckMediaFromPrompt(`[form answers — discovery]
- SVG / 图片辅助描述希望重点用在哪些页面？: 能力体系总览图, 对比页（传统 vs 原子化）`);

    expect(deckMedia?.keySlidePolicy).toContain('能力体系总览图, 对比页（传统 vs 原子化）');
    expect(deckMedia?.keySlidePolicy).toContain('generated image bytes');
  });

  it('does not trigger when the user explicitly declines generated imagery', () => {
    expect(deckMediaFromPrompt('关键页面不要生成图片，用纯文字即可')).toBeNull();
  });

  it('recovers media intent from recent user context when the current send is a continuation', () => {
    const resolved = resolveDeckMediaIntentPrompt('继续啊', [
      '按照文档介绍这个底层原子能力干啥的。重要的页面创建 svg/image 进行插入辅助描述',
    ]);

    expect(resolved).toContain('svg/image');
    expect(deckMediaFromPrompt(resolved)?.required).toBe(true);
  });

  it('auto-selects the single available image environment before the agent starts', () => {
    const environments = deckMediaImageEnvironments({
      daemonProviders: {
        openai: {
          configured: true,
          source: 'oauth-codex',
          baseUrl: '',
        },
      },
      codexImageProxyStatus: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:51235/v1',
        endpoint: '/images/generations',
        defaultModel: 'gpt-image-2',
        auth: {
          configured: true,
          source: 'oauth-codex',
          accountIdConfigured: true,
          accountIdTail: 'abcd',
        },
        proxyKey: {
          enabled: false,
          env: 'OD_CODEX_IMAGE_PROXY_KEY',
        },
        backend: {
          forceCodexBackend: false,
          useResponsesTool: false,
          responsesModel: 'gpt-5.2',
        },
      },
    });

    expect(environments).toEqual([
      expect.objectContaining({
        id: 'codex-image-proxy',
        model: 'gpt-image-2',
      }),
    ]);
    expect(
      deckMediaImageModelChoice({
        prompt: '关键页面生成图片辅助描述',
        environments,
      }),
    ).toEqual({ model: 'gpt-image-2' });
    expect(deckMediaFromPrompt('关键页面生成图片辅助描述', undefined, 'gpt-image-2')?.imageModel).toBe(
      'gpt-image-2',
    );
  });

  it('continues with pending media slots when no image environment is available', () => {
    const choice = deckMediaImageModelChoice({
      prompt: '重要页面生成配图',
      environments: [],
    });

    expect(choice).toEqual({ notice: { kind: 'missing-provider' } });
    const deckMedia = deckMediaFromPrompt('重要页面生成配图', undefined, choice.model);
    expect(deckMedia).toMatchObject({
      enabled: true,
      required: true,
    });
    expect(deckMedia?.imageModel).toBeUndefined();
  });

  it('continues with pending media slots when multiple image environments need a model choice', () => {
    const environments = deckMediaImageEnvironments({
      daemonProviders: {
        openai: { configured: true, source: 'stored', baseUrl: '' },
        volcengine: { configured: true, source: 'stored', baseUrl: '' },
      },
    });

    const choice = deckMediaImageModelChoice({
      prompt: '重要页面生成配图',
      environments,
    });

    expect(choice.model).toBeUndefined();
    expect(choice.notice).toMatchObject({ kind: 'ambiguous-provider' });
    expect(choice.notice?.kind === 'ambiguous-provider' ? choice.notice.choices : '').toContain(
      'gpt-image-2',
    );
    expect(choice.notice?.kind === 'ambiguous-provider' ? choice.notice.choices : '').toContain(
      'doubao-seedream-3-0-t2i-250415',
    );
  });
});

describe('ProjectView Open Slide inspect chat behavior', () => {
  it('auto-collapses the chat when entering inspect with an open chat pane', () => {
    expect(shouldAutoCollapseChatForOpenSlideInspect({
      inspectActive: true,
      chatCollapsed: false,
      userExpandedAfterAutoCollapse: false,
    })).toBe(true);
  });

  it('does not fight the user after they reopen an auto-collapsed chat pane', () => {
    expect(shouldAutoCollapseChatForOpenSlideInspect({
      inspectActive: true,
      chatCollapsed: false,
      userExpandedAfterAutoCollapse: true,
    })).toBe(false);
  });

  it('does nothing when inspect is inactive or the chat is already collapsed', () => {
    expect(shouldAutoCollapseChatForOpenSlideInspect({
      inspectActive: false,
      chatCollapsed: false,
      userExpandedAfterAutoCollapse: false,
    })).toBe(false);
    expect(shouldAutoCollapseChatForOpenSlideInspect({
      inspectActive: true,
      chatCollapsed: true,
      userExpandedAfterAutoCollapse: false,
    })).toBe(false);
  });
});
