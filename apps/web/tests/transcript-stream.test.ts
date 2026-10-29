import { afterEach, expect, it, vi } from 'vitest';
import { listMessages } from '../src/state/projects';
afterEach(() => vi.unstubAllGlobals());
it('reads a transcript across UTF-8 boundaries and accepts a final line without newline', async () => {
  const messages = [{ id: 'a', role: 'assistant', content: '你好🌏', runStatus: 'failed', runError: { code: 'DAEMON_RESTARTED', message: 'interrupted' } }];
  const bytes = new TextEncoder().encode(JSON.stringify(messages[0]));
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.from([byte]));
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  expect(await listMessages('p', 'c')).toEqual(messages);
});
it('keeps JSON compatibility with older daemons', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'old', content: 'older' }] }), {
    headers: { 'Content-Type': 'application/json' },
  })));
  expect((await listMessages('p', 'c'))[0]?.id).toBe('old');
});
