// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatRunService } from '../src/runs.js';

function createErrorPayload(code: string, message: string, init: Record<string, unknown> = {}) {
  return {
    message,
    error: {
      code,
      message,
      ...init,
    },
  };
}

function createRuns(options: Record<string, unknown> = {}) {
  return createChatRunService({
    createSseResponse: () => ({
      send() {},
      end() {},
      cleanup() {},
    }),
    createSseErrorPayload: createErrorPayload,
    ttlMs: 1_000,
    ...options,
  });
}

describe('createChatRunService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a run after the idle timeout when the agent makes no observable progress', async () => {
    vi.useFakeTimers();
    const signals: string[] = [];
    const runs = createRuns({
      idleTimeoutMs: 1_000,
      cancelGraceMs: 0,
      terminateChild: (_child: unknown, signal: string) => {
        signals.push(signal);
        return true;
      },
    });
    const run = runs.create();
    run.child = { pid: 123, exitCode: null, signalCode: null };

    runs.start(run, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(run.status).toBe('failed');
    expect(signals).toEqual(['SIGTERM']);
    expect(run.events.find((event) => event.event === 'error')?.data.error.code)
      .toBe('AGENT_IDLE_TIMEOUT');
    expect(run.events.at(-1)?.event).toBe('end');
  });

  it('resets the idle timeout whenever a run emits progress', async () => {
    vi.useFakeTimers();
    const runs = createRuns({ idleTimeoutMs: 1_000, cancelGraceMs: 0 });
    const run = runs.create();

    runs.start(run, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(900);
    expect(run.status).toBe('queued');

    runs.emit(run, 'agent', { type: 'status', label: 'thinking' });
    await vi.advanceTimersByTimeAsync(900);
    expect(run.status).toBe('queued');

    await vi.advanceTimersByTimeAsync(100);
    expect(run.status).toBe('failed');
  });

  it('cancels immediately and escalates process-tree termination after the grace period', async () => {
    vi.useFakeTimers();
    const signals: string[] = [];
    const runs = createRuns({
      idleTimeoutMs: 0,
      cancelGraceMs: 1_000,
      terminateChild: (_child: unknown, signal: string) => {
        signals.push(signal);
        return true;
      },
    });
    const run = runs.create();
    run.child = { pid: 123, exitCode: null, signalCode: null };

    runs.start(run, () => new Promise(() => {}));
    runs.cancel(run);

    expect(run.status).toBe('canceled');
    expect(signals).toEqual(['SIGTERM']);
    expect(run.events.at(-1)?.event).toBe('end');

    await vi.advanceTimersByTimeAsync(999);
    expect(signals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
