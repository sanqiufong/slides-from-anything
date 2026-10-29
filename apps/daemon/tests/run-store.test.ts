import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { RunStore } from '../src/run-store.js';
import { createChatRunService } from '../src/runs.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  const store = new RunStore(db);
  const received: unknown[][] = [];
  const options = { store, maxEvents: 2, idleTimeoutMs: 0,
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    createSseResponse: () => ({ send: (...event: unknown[]) => received.push(event), end() {}, cleanup() {} }) };
  return { store, received, options, runs: createChatRunService(options) };
}
it('replays events beyond the in-memory cap from a reopened service and honors the cursor', () => {
  const { store, received, options, runs } = fixture();
  const run = runs.create({ projectId: 'p', conversationId: 'c', assistantMessageId: 'm' });
  for (let i = 0; i < 8; i++) runs.emit(run, 'stdout', { chunk: String(i) });
  runs.finish(run, 'succeeded', 0);
  const reopened = createChatRunService(options);
  const restored = reopened.get(run.id);
  reopened.stream(restored, { get: () => '3', query: {} }, {});
  expect(received.map(event => event[2])).toEqual([4, 5, 6, 7, 8, 9]);
  expect(store.hydrate({ id: 'm', role: 'assistant', content: '' }, 'p', 'c').content).toBe('01234567');
  expect(store.get(run.id)?.status).toBe('succeeded');
});
it('marks interrupted runs failed exactly once and keeps output and correlation authoritative', () => {
  const { store, runs } = fixture();
  const run = runs.create({ projectId: 'p', conversationId: 'c', assistantMessageId: 'm' });
  run.status = 'running';
  runs.emit(run, 'stdout', { chunk: 'Already generated 中文' });
  store.recoverInterrupted(); store.recoverInterrupted();
  const hydrated = store.hydrate({ id: 'm', role: 'assistant', content: 'stale', runId: 'bogus', runStatus: 'running' }, 'p', 'c');
  expect(hydrated.content).toBe('Already generated 中文');
  expect(hydrated.runStatus).toBe('failed');
  expect(hydrated.runError?.code).toBe('DAEMON_RESTARTED');
  expect(store.events(run.id).filter(event => event.event === 'end')).toHaveLength(1);
  expect(store.hydrate({ id: 'm', role: 'assistant', content: 'other' }, 'other-project', 'c').content).toBe('other');
});
