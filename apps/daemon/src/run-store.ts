import type Database from 'better-sqlite3';
import type { ChatMessage, ChatRunStatusResponse, PersistedAgentEvent } from '@open-design/contracts/api/chat';

export interface StoredRun extends ChatRunStatusResponse {
  clientRequestId?: string | null;
}
export interface StoredRunEvent { id: number; event: string; data: any }

/** SQLite is the authority for run state and replay; a browser is only a subscriber. */
export class RunStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_runs (
        id TEXT PRIMARY KEY, project_id TEXT, conversation_id TEXT, assistant_message_id TEXT,
        client_request_id TEXT, status TEXT NOT NULL, updated_at INTEGER NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_runs_project ON chat_runs(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS chat_runs_message ON chat_runs(conversation_id, assistant_message_id);
      CREATE TABLE IF NOT EXISTS chat_run_events (
        run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
        event_id INTEGER NOT NULL, event TEXT NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY(run_id, event_id)
      );
    `);
  }

  save(run: StoredRun): void {
    const record: StoredRun = {
      id: run.id, projectId: run.projectId, conversationId: run.conversationId,
      assistantMessageId: run.assistantMessageId, clientRequestId: run.clientRequestId ?? null,
      agentId: run.agentId, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
      exitCode: run.exitCode ?? null, signal: run.signal ?? null, errorCode: run.errorCode ?? null,
      errorMessage: run.errorMessage ?? null, ...(run.delivery ? { delivery: run.delivery } : {}),
    };
    this.db.prepare(`INSERT INTO chat_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, record_json=excluded.record_json`)
      .run(record.id, record.projectId, record.conversationId, record.assistantMessageId,
        record.clientRequestId ?? null, record.status, record.updatedAt, JSON.stringify(record));
  }

  append(run: StoredRun, event: StoredRunEvent): void {
    this.db.transaction(() => {
      this.save(run);
      this.db.prepare('INSERT INTO chat_run_events VALUES (?, ?, ?, ?)')
        .run(run.id, event.id, event.event, JSON.stringify(event.data));
    })();
  }

  get(id: string): StoredRun | null {
    const row = this.db.prepare('SELECT record_json FROM chat_runs WHERE id=?').get(id) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as StoredRun : null;
  }

  all(): StoredRun[] {
    return (this.db.prepare('SELECT record_json FROM chat_runs ORDER BY updated_at DESC').all() as Array<{ record_json: string }>)
      .map(row => JSON.parse(row.record_json) as StoredRun);
  }

  events(id: string, after = 0): StoredRunEvent[] {
    return (this.db.prepare('SELECT event_id, event, data_json FROM chat_run_events WHERE run_id=? AND event_id>? ORDER BY event_id')
      .all(id, after) as Array<{ event_id: number; event: string; data_json: string }>)
      .map(row => ({ id: row.event_id, event: row.event, data: JSON.parse(row.data_json) }));
  }

  /** No process is spawned or request retried during restart reconciliation. */
  recoverInterrupted(): void {
    this.db.transaction(() => {
      for (const record of this.all()) {
        if (record.status !== 'queued' && record.status !== 'running') continue;
        const run: StoredRun = { ...record, status: 'failed', updatedAt: Date.now(), errorCode: 'DAEMON_RESTARTED',
          errorMessage: 'The daemon restarted before this run finished. Existing output was retained. Retry explicitly to continue.' };
        const previous = this.db.prepare('SELECT MAX(event_id) AS last FROM chat_run_events WHERE run_id=?').get(run.id) as { last: number | null };
        const last = previous.last ?? 0;
        this.append(run, { id: last + 1, event: 'error', data: {
          message: run.errorMessage, error: { code: run.errorCode, message: run.errorMessage, retryable: true },
        } });
        this.append(run, { id: last + 2, event: 'end', data: { status: 'failed', code: null, signal: null } });
      }
    })();
    this.reconcileMessages();
  }

  hydrate(message: ChatMessage, projectId: string, conversationId: string): ChatMessage {
    let row = message.runId ? this.get(message.runId) : null;
    if (!row || row.projectId !== projectId || row.conversationId !== conversationId || row.assistantMessageId !== message.id) {
      row = this.findForMessage(conversationId, message.id);
    }
    if (!row || row.projectId !== projectId || row.conversationId !== conversationId || row.assistantMessageId !== message.id) return message;
    const records = this.events(row.id);
    const events: PersistedAgentEvent[] = [];
    let text = '';
    for (const event of records) {
      let translated: PersistedAgentEvent | null = null;
      if (event.event === 'stdout') translated = { kind: 'text', text: String(event.data.chunk ?? '') };
      if (event.event === 'agent') {
        const data = event.data;
        if (data.type === 'text_delta') translated = { kind: 'text', text: String(data.delta ?? '') };
        else if (data.type === 'thinking_delta') translated = { kind: 'thinking', text: String(data.delta ?? '') };
        else if (data.type === 'tool_use') translated = { kind: 'tool_use', id: data.id, name: data.name, input: data.input };
        else if (data.type === 'tool_result') translated = { kind: 'tool_result', toolUseId: data.toolUseId, content: data.content, isError: Boolean(data.isError) };
        else if (data.type === 'usage') translated = { kind: 'usage', inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens, costUsd: data.costUsd, durationMs: data.durationMs };
        else if (data.type === 'status') translated = { kind: 'status', label: data.label, detail: data.detail ?? data.model };
        else if (data.type === 'raw') translated = { kind: 'raw', line: data.line };
        else if (data.type === 'live_artifact' || data.type === 'live_artifact_refresh') {
          const { type, ...rest } = data;
          translated = { kind: type, ...rest } as PersistedAgentEvent;
        }
      }
      if (!translated) continue;
      if (translated.kind === 'text') text += translated.text;
      const last = events.at(-1);
      if ((translated.kind === 'text' || translated.kind === 'thinking') && last?.kind === translated.kind) {
        (last as { text: string }).text += translated.text;
      } else events.push(translated);
    }
    const hydrated: ChatMessage = { ...message, role: 'assistant', content: text || message.content,
      runId: row.id, runStatus: row.status, startedAt: row.createdAt };
    if (records.length) hydrated.events = events;
    if (records.at(-1)) hydrated.lastRunEventId = String(records.at(-1)!.id);
    if (row.status === 'running' || row.status === 'queued') delete hydrated.endedAt;
    else hydrated.endedAt = row.updatedAt;
    if (row.delivery) hydrated.delivery = row.delivery;
    if (row.errorCode) hydrated.runError = { code: row.errorCode, message: row.errorMessage ?? row.errorCode };
    return hydrated;
  }

  private findForMessage(conversationId: string, messageId: string): StoredRun | null {
    const row = this.db.prepare('SELECT record_json FROM chat_runs WHERE conversation_id=? AND assistant_message_id=? ORDER BY updated_at DESC LIMIT 1')
      .get(conversationId, messageId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as StoredRun : null;
  }

  deleteProject(projectId: string): void {
    this.db.prepare('DELETE FROM chat_runs WHERE project_id=?').run(projectId);
  }

  reconcileMessages(runId?: string): void {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get()) return;
    const rows = this.db.prepare(`SELECT m.id, m.content, m.run_id AS runId, m.role, m.conversation_id AS conversationId,
      c.project_id AS projectId FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.role='assistant'
      ${runId ? 'AND (m.run_id=? OR m.id=(SELECT assistant_message_id FROM chat_runs WHERE id=?))' : ''}`)
      .all(...(runId ? [runId, runId] : [])) as Array<ChatMessage & { projectId: string; conversationId: string }>;
    const update = this.db.prepare(`UPDATE messages SET content=?, events_json=?, run_id=?, run_status=?, last_run_event_id=?, started_at=?, ended_at=? WHERE id=?`);
    this.db.transaction(() => {
      for (const row of rows) {
        const message = this.hydrate(row, row.projectId, row.conversationId);
        if (!message.runId) continue;
        update.run(message.content, JSON.stringify(message.events ?? []), message.runId, message.runStatus,
          message.lastRunEventId ?? null, message.startedAt ?? null, message.endedAt ?? null, message.id);
      }
    })();
  }
}
