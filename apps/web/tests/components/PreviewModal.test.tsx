// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewModal } from '../../src/components/PreviewModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PreviewModal sandbox isolation', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal('ResizeObserver', class {
      observe() { }
      disconnect() { }
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders generated previews without same-origin sandbox access', () => {
    const markup = renderToStaticMarkup(
      <PreviewModal
        title="Unsafe preview"
        views={[
          {
            id: 'preview',
            label: 'Preview',
            html: '<script>window.parent.document.body.innerHTML="owned"</script>',
          },
        ]}
        exportTitleFor={() => 'unsafe-preview'}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain('allow-same-origin');
    expect(markup).toContain('srcDoc=');
  });

  it('keeps deck srcdoc handling for deck preview views', () => {
    const markup = renderToStaticMarkup(
      <PreviewModal
        title="Deck preview"
        views={[
          {
            id: 'deck',
            label: 'Deck',
            html: '<section class="slide">one</section><section class="slide">two</section>',
            deck: true,
          },
        ]}
        exportTitleFor={() => 'deck-preview'}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain('allow-same-origin');
    expect(markup).toContain('od:slide');
  });

  it('requests fullscreen on the modal shell so exit controls stay visible', async () => {
    const modalRequestFullscreen = vi.fn(() => Promise.resolve());
    const stageRequestFullscreen = vi.fn(() => Promise.resolve());

    await act(async () => {
      root.render(
        <PreviewModal
          title="Deck preview"
          views={[{ id: 'deck', label: 'Deck', html: '<section>one</section>' }]}
          exportTitleFor={() => 'deck-preview'}
          onClose={() => {}}
        />,
      );
      await Promise.resolve();
    });

    const modal = document.querySelector<HTMLElement>('[data-testid="preview-modal-shell"]');
    const stage = document.querySelector<HTMLElement>('.ds-modal-stage');
    expect(modal).not.toBeNull();
    expect(stage).not.toBeNull();
    Object.defineProperty(modal, 'requestFullscreen', { configurable: true, value: modalRequestFullscreen });
    Object.defineProperty(stage, 'requestFullscreen', { configurable: true, value: stageRequestFullscreen });

    const fullscreenButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Fullscreen'),
    );
    expect(fullscreenButton).not.toBeUndefined();

    await act(async () => {
      fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(modalRequestFullscreen).toHaveBeenCalledTimes(1);
    expect(stageRequestFullscreen).not.toHaveBeenCalled();
  });
});
