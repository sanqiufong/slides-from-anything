import { StringDecoder } from 'node:string_decoder';

type RecordValue = Record<string, any>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Qoder JSONL wrappers and optional partial messages; state belongs to one run. */
export function createQoderStreamHandler(onEvent: (event: RecordValue) => void) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let messageId = 'anonymous';
  let fatal = false;
  const emittedText = new Map<string, string>();
  const emittedTools = new Set<string>();
  const blocks = new Map<string, { id: string; name: string; input: string }>();
  const raw = (line: string) => onEvent({ type: 'raw', line: line.length > 16000 ? `${line.slice(0, 16000)}…` : line });
  const error = (value: unknown) => {
    fatal = true;
    const message = typeof value === 'string' ? value : record(value) && typeof value.message === 'string' ? value.message : 'Qoder run failed';
    onEvent({ type: 'error', message });
  };
  const tool = (value: RecordValue) => {
    if (!value.id || emittedTools.has(value.id)) return;
    emittedTools.add(value.id);
    onEvent({ type: 'tool_use', id: value.id, name: value.name ?? 'tool', input: value.input ?? {} });
  };
  const text = (key: string, value: string, partial = false) => {
    const previous = emittedText.get(key) ?? '';
    const delta = partial ? value : value.startsWith(previous) ? value.slice(previous.length) : previous ? '' : value;
    emittedText.set(key, partial ? previous + value : value);
    if (delta) onEvent({ type: 'text_delta', delta });
  };
  function handle(value: unknown, line: string) {
    if (!record(value)) return;
    if (value.type === 'system') {
      onEvent({ type: 'status', label: value.subtype === 'init' ? 'initializing' : value.status ?? 'working', model: value.model });
      return;
    }
    if (value.type === 'stream_event' && record(value.event)) {
      const event = value.event;
      if (event.type === 'message_start') messageId = event.message?.id ?? `message-${emittedText.size}`;
      const key = `${messageId}:${event.index ?? 0}`;
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        blocks.set(key, { id: event.content_block.id, name: event.content_block.name, input: '' });
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') text(key, String(event.delta.text ?? ''), true);
        else if (event.delta?.type === 'thinking_delta') onEvent({ type: 'thinking_delta', delta: String(event.delta.thinking ?? '') });
        else if (event.delta?.type === 'input_json_delta') {
          const block = blocks.get(key);
          if (block) block.input += event.delta.partial_json ?? '';
        }
      } else if (event.type === 'content_block_stop') {
        const block = blocks.get(key);
        if (block) {
          let input: unknown = {};
          try { input = JSON.parse(block.input || '{}'); } catch { input = { raw: block.input }; }
          tool({ ...block, input });
          blocks.delete(key);
        }
      }
      return;
    }
    if ((value.type === 'assistant' || value.type === 'user') && record(value.message)) {
      const id = value.message.id ?? messageId;
      const content = typeof value.message.content === 'string' ? [{ type: 'text', text: value.message.content }] : value.message.content;
      if (Array.isArray(content)) content.forEach((block, index) => {
        if (!record(block)) return;
        if (block.type === 'text' && value.type === 'assistant') text(`${id}:${index}`, String(block.text ?? ''));
        else if (block.type === 'thinking') onEvent({ type: 'thinking_delta', delta: String(block.thinking ?? '') });
        else if (block.type === 'tool_use') tool(block);
        else if (block.type === 'tool_result') onEvent({ type: 'tool_result', toolUseId: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''), isError: Boolean(block.is_error) });
      });
      // Anonymous wrappers can be separate turns; only identified wrappers are snapshots.
      if (!value.message.id && messageId === 'anonymous') emittedText.clear();
      if (value.error) error(value.error);
      return;
    }
    if (value.type === 'result') {
      onEvent({ type: 'usage', usage: value.usage ?? {}, costUsd: value.total_cost_usd, durationMs: value.duration_ms });
      if (value.is_error || value.error) error(value.error ?? value.message ?? value.stop_reason);
      return;
    }
    if (value.type === 'error') { error(value.error ?? value.message); return; }
    raw(line);
  }
  function line(value: string) {
    if (!value.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { raw(value); return; }
    handle(parsed, value);
  }
  return {
    feed(chunk: string | Buffer) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    },
    flush() { line(buffer + decoder.end()); buffer = ''; },
    hasFatalError() { return fatal; },
  };
}
