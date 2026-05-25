// @vitest-environment jsdom

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenSlideCanvas } from '../../src/components/FileWorkspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('OpenSlideCanvas inspect selection', () => {
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

  it('does not mark selected slide nodes when inspect mode is inactive', async () => {
    await act(async () => {
      root.render(
        <OpenSlideCanvas
          design={null}
          scale={1}
          inspectActive={false}
          selected={{ line: 1, column: 2, targetLabel: 'Headline' }}
        >
          <section>
            <h1 data-slide-loc="1:2">Headline</h1>
          </section>
        </OpenSlideCanvas>,
      );
      await Promise.resolve();
    });

    expect(document.querySelector('[data-open-slide-selected="true"]')).toBeNull();
    expect(document.querySelector('.open-slide-selection-frame')).toBeNull();
  });

  it('keeps selection measurement stable across repeated parent renders', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function RerenderingCanvas() {
      const [tick, setTick] = useState(0);

      useEffect(() => {
        if (tick < 8) setTick((value) => value + 1);
      }, [tick]);

      return (
        <OpenSlideCanvas
          design={null}
          scale={1}
          inspectActive
          selected={{ line: 1, column: 2, targetLabel: `Headline ${tick}` }}
        >
          <section data-render-tick={tick}>
            <h1 data-slide-loc="1:2">Headline</h1>
          </section>
        </OpenSlideCanvas>
      );
    }

    await act(async () => {
      root.render(<RerenderingCanvas />);
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    });

    expect(document.querySelector('[data-open-slide-selected="true"]')?.textContent).toBe('Headline');
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('Maximum update depth exceeded'),
    );
  });

  it('places a feedback action on the selected frame in inspect mode', async () => {
    const onRequestFeedback = vi.fn();
    const selected = { line: 1, column: 2, targetLabel: 'Headline' };

    await act(async () => {
      root.render(
        <OpenSlideCanvas
          design={null}
          scale={1}
          inspectActive
          selected={selected}
          onRequestFeedback={onRequestFeedback}
        >
          <section>
            <h1 data-slide-loc="1:2">Headline</h1>
          </section>
        </OpenSlideCanvas>,
      );
      await Promise.resolve();
    });

    const action = document.querySelector<HTMLButtonElement>('.open-slide-selection-feedback-action');
    expect(action).not.toBeNull();
    expect(action?.getAttribute('aria-label')).toBe('Add feedback');

    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onRequestFeedback).toHaveBeenCalledWith(selected);
  });
});
