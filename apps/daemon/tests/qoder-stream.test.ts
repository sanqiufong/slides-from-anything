import { expect, it } from 'vitest';
import { createQoderStreamHandler } from '../src/qoder-stream.js';

it('handles every UTF-8 split and a trailing record without duplicating partial text or tools', () => {
  const records = [
    { type: 'system', subtype: 'init', model: 'default' },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'a' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好🌏' } } },
    { type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: '你好🌏' }, { type: 'tool_use', id: 't', name: 'Read', input: { path: 'index.tsx' } }] } },
    { type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: '你好🌏' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'source' }] } },
    { type: 'result', usage: { input_tokens: 10, output_tokens: 4 }, total_cost_usd: 0.01 },
  ];
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n'));
  const events: Array<Record<string, any>> = [];
  const parser = createQoderStreamHandler(event => events.push(event));
  for (const byte of bytes) parser.feed(Buffer.from([byte]));
  parser.flush();
  expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe('你好🌏');
  expect(events.filter(event => event.type === 'tool_use')).toHaveLength(1);
  expect(events.find(event => event.type === 'tool_result')?.toolUseId).toBe('t');
  expect(events.find(event => event.type === 'usage')?.usage.output_tokens).toBe(4);
  expect(parser.hasFatalError()).toBe(false);
});
it('reports result errors even after text and bounds unknown records', () => {
  const events: Array<Record<string, any>> = [];
  const parser = createQoderStreamHandler(event => events.push(event));
  parser.feed(JSON.stringify({ type: 'assistant', message: { content: 'partial' } }) + '\n');
  parser.feed(JSON.stringify({ type: 'result', is_error: true, error: { message: 'quota exceeded' } }) + '\n');
  parser.feed('x'.repeat(40000)); parser.flush();
  expect(events.find(event => event.type === 'error')?.message).toBe('quota exceeded');
  expect(parser.hasFatalError()).toBe(true);
  expect(events.at(-1)?.line.length).toBeLessThan(16010);
});
