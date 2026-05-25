// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenSlidePlayerOverlay, type OpenSlideRuntimePage } from '../../src/components/FileWorkspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('OpenSlidePlayerOverlay page transitions', () => {
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

  it('marks forward and backward page changes with transition direction', async () => {
    const pages: OpenSlideRuntimePage[] = [
      () => <section>First page</section>,
      () => <section>Second page</section>,
    ];
    const onSelect = vi.fn();

    await act(async () => {
      root.render(
        <OpenSlidePlayerOverlay
          pages={pages}
          design={null}
          activeIndex={0}
          onSelect={onSelect}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="open-slide-player-stage"]')?.getAttribute('data-transition')).toBe('initial');
    expect(document.body.textContent).toContain('First page');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.open-slide-player-zone.next')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="open-slide-player-stage"]')?.getAttribute('data-transition')).toBe('forward');
    expect(document.querySelector('[data-testid="open-slide-player-stage"]')?.getAttribute('data-page-index')).toBe('1');
    expect(document.body.textContent).toContain('Second page');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.open-slide-player-zone.prev')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="open-slide-player-stage"]')?.getAttribute('data-transition')).toBe('backward');
    expect(document.querySelector('[data-testid="open-slide-player-stage"]')?.getAttribute('data-page-index')).toBe('0');
    expect(document.body.textContent).toContain('First page');
  });
});
