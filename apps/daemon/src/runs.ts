// @ts-nocheck
import { randomUUID } from 'node:crypto';
import { spawn as spawnChildProcess } from 'node:child_process';

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CANCEL_GRACE_MS = 3 * 1000;

export function createChatRunService({
  createSseResponse,
  createSseErrorPayload,
  maxEvents = 2_000,
  ttlMs = 30 * 60 * 1000,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
  terminateChild = terminateChildProcess,
}) {
  const runs = new Map();
  const normalizedIdleTimeoutMs = normalizePositiveMs(idleTimeoutMs);
  const normalizedCancelGraceMs = normalizePositiveMs(cancelGraceMs);

  const create = (meta = {}) => {
    const now = Date.now();
    const run = {
      id: randomUUID(),
      projectId: typeof meta.projectId === 'string' && meta.projectId ? meta.projectId : null,
      conversationId: typeof meta.conversationId === 'string' && meta.conversationId ? meta.conversationId : null,
      assistantMessageId: typeof meta.assistantMessageId === 'string' && meta.assistantMessageId ? meta.assistantMessageId : null,
      clientRequestId: typeof meta.clientRequestId === 'string' && meta.clientRequestId ? meta.clientRequestId : null,
      agentId: typeof meta.agentId === 'string' && meta.agentId ? meta.agentId : null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
      nextEventId: 1,
      clients: new Set(),
      waiters: new Set(),
      child: null,
      acpSession: null,
      exitCode: null,
      signal: null,
      cancelRequested: false,
      idleTimer: null,
      forceKillTimer: null,
    };
    runs.set(run.id, run);
    return run;
  };

  const get = (id) => runs.get(id) ?? null;

  const scheduleCleanup = (run) => {
    setTimeout(() => {
      if (TERMINAL_RUN_STATUSES.has(run.status)) runs.delete(run.id);
    }, ttlMs).unref?.();
  };

  const clearIdleTimer = (run) => {
    if (!run.idleTimer) return;
    clearTimeout(run.idleTimer);
    run.idleTimer = null;
  };

  const scheduleIdleTimeout = (run) => {
    clearIdleTimer(run);
    if (!normalizedIdleTimeoutMs || TERMINAL_RUN_STATUSES.has(run.status)) return;
    run.idleTimer = setTimeout(() => {
      if (TERMINAL_RUN_STATUSES.has(run.status)) return;
      const idleMs = Math.max(0, Date.now() - run.updatedAt);
      run.cancelRequested = true;
      requestChildTermination(run, 'SIGTERM');
      emit(run, 'error', createSseErrorPayload(
        'AGENT_IDLE_TIMEOUT',
        `Agent run made no observable progress for ${formatDuration(normalizedIdleTimeoutMs)} and was stopped. It may be blocked on a long-running foreground command such as a dev server.`,
        {
          retryable: true,
          details: { idleMs, timeoutMs: normalizedIdleTimeoutMs },
        },
      ));
      finish(run, 'failed', null, 'SIGTERM');
    }, normalizedIdleTimeoutMs);
    run.idleTimer.unref?.();
  };

  const requestChildTermination = (run, signal) => {
    const child = run.child;
    if (!child) return false;
    const signaled = terminateChild(child, signal);
    if (
      signaled &&
      signal !== 'SIGKILL' &&
      normalizedCancelGraceMs &&
      !run.forceKillTimer
    ) {
      run.forceKillTimer = setTimeout(() => {
        run.forceKillTimer = null;
        terminateChild(child, 'SIGKILL');
      }, normalizedCancelGraceMs);
      run.forceKillTimer.unref?.();
    }
    return signaled;
  };

  const emit = (run, event, data) => {
    if (TERMINAL_RUN_STATUSES.has(run.status) && event !== 'end') return null;
    const id = run.nextEventId++;
    const record = { id, event, data };
    run.events.push(record);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
    run.updatedAt = Date.now();
    scheduleIdleTimeout(run);
    for (const sse of run.clients) sse.send(event, data, id);
    return record;
  };

  const statusBody = (run) => ({
    id: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    assistantMessageId: run.assistantMessageId,
    agentId: run.agentId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    exitCode: run.exitCode,
    signal: run.signal,
  });

  const finish = (run, status, code = null, signal = null) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    clearIdleTimer(run);
    run.status = status;
    run.exitCode = code;
    run.signal = signal;
    run.updatedAt = Date.now();
    emit(run, 'end', { code, signal, status });
    for (const sse of run.clients) sse.end();
    run.clients.clear();
    for (const waiter of run.waiters) waiter(statusBody(run));
    run.waiters.clear();
    scheduleCleanup(run);
  };

  const fail = (run, code, message, init = {}) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    emit(run, 'error', createSseErrorPayload(code, message, init));
    finish(run, 'failed', 1, null);
  };

  const start = (run, starter) => {
    scheduleIdleTimeout(run);
    void starter(run).catch((err) => {
      fail(run, 'AGENT_EXECUTION_FAILED', err instanceof Error ? err.message : String(err));
    });
    return run;
  };

  const stream = (run, req, res) => {
    const sse = createSseResponse(res);
    const lastEventId = Number(req.get('Last-Event-ID') || req.query.after || 0);
    for (const record of run.events) {
      if (!Number.isFinite(lastEventId) || record.id > lastEventId) {
        sse.send(record.event, record.data, record.id);
      }
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      sse.end();
      return;
    }
    run.clients.add(sse);
    res.on('close', () => {
      run.clients.delete(sse);
      sse.cleanup();
    });
  };

  const list = ({ projectId, conversationId, status } = {}) => Array.from(runs.values()).filter((run) => {
    if (typeof projectId === 'string' && projectId && run.projectId !== projectId) return false;
    if (typeof conversationId === 'string' && conversationId && run.conversationId !== conversationId) return false;
    if (status === 'active') return !TERMINAL_RUN_STATUSES.has(run.status);
    if (typeof status === 'string' && status) return run.status === status;
    return true;
  });

  const cancel = (run) => {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      run.cancelRequested = true;
      run.updatedAt = Date.now();
      requestChildTermination(run, 'SIGTERM');
      finish(run, 'canceled', null, 'SIGTERM');
    }
  };

  const wait = (run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return Promise.resolve(statusBody(run));
    return new Promise((resolve) => run.waiters.add(resolve));
  };

  return {
    create,
    start,
    get,
    list,
    stream,
    cancel,
    wait,
    emit,
    finish,
    fail,
    statusBody,
    isTerminal(status) {
      return TERMINAL_RUN_STATUSES.has(status);
    },
  };
}

function normalizePositiveMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.floor(n));
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function terminateChildProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  if (process.platform === 'win32' && child.pid) {
    const args = ['/pid', String(child.pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    const killer = spawnChildProcess(
      'taskkill',
      args,
      { stdio: 'ignore' },
    );
    killer.on('error', () => {
      try {
        child.kill(signal);
      } catch {
        // best effort
      }
    });
    return true;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (err) {
      if (err?.code !== 'ESRCH') {
        try {
          child.kill(signal);
          return true;
        } catch {
          return false;
        }
      }
    }
  }
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}
