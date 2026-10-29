import type http from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import type { ChatRunCreateResponse, ChatRunStatusResponse } from '@open-design/contracts/api/chat';
import type { DeckVersionsResponse } from '@open-design/contracts/api/openppt';

let server: http.Server;
let url: string;
let bin: string;
const originalPath = process.env.PATH;
beforeAll(async () => {
  bin = await mkdtemp(path.join(os.tmpdir(), 'od-qoder-fixture-'));
  const executable = path.join(bin, 'qodercli');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('1.1.78'); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => { setTimeout(() => {
  const args = process.argv;
  const cwd = args[args.indexOf('--cwd') + 1];
  const file = path.join(cwd, 'slides', 'acceptance', 'index.tsx');
  fs.writeFileSync(file, 'export default [() => <Missing />];');
  console.log(JSON.stringify({type:'assistant', message:{id:'test', content:[{type:'text', text:'partial output 中文'}]}}));
  console.log(JSON.stringify({type:'result', usage:{input_tokens:2,output_tokens:3}}));
}, 200); });
`);
  await chmod(executable, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
  const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server };
  url = started.url; server = started.server;
});
afterAll(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(bin, { recursive: true, force: true });
});
async function post(endpoint: string, body: unknown, method = 'POST') {
  return fetch(url + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
it('fails exit-zero invalid decks, persists reports and replay, and restores source through the public API', async () => {
  const project = await (await post('/api/projects', { id: 'deck-route-acceptance', name: 'Acceptance', metadata: { kind: 'deck', slideId: 'acceptance', animations: false } })).json() as { project: { id: string }; conversationId: string };
  const id = project.project.id;
  const cid = project.conversationId;
  const sourceUrl = `/api/projects/${id}/open-slide/source?slideId=acceptance`;
  const original = await (await fetch(url + sourceUrl)).json() as { source: string };
  const mid = 'assistant-delivery';
  const input = { projectId: id, conversationId: cid, assistantMessageId: mid, clientRequestId: 'once', agentId: 'qodercli', message: 'fixture' };
  const created = await (await post('/api/runs', input)).json() as ChatRunCreateResponse;
  const duplicate = await (await post('/api/runs', input)).json() as ChatRunCreateResponse;
  expect(duplicate.runId).toBe(created.runId);
  const busy = await post(`/api/projects/${id}/open-slide/versions/restore`, { slideId: 'acceptance' });
  expect(busy.status).toBe(409);
  const parallel = await post('/api/runs', { ...input, clientRequestId: 'second-run' });
  expect(parallel.status).toBe(409);
  const stream = await (await fetch(`${url}/api/runs/${created.runId}/events`)).text();
  expect(stream).toContain('partial output 中文');
  expect(stream).toContain('DECK_DELIVERY_INVALID');
  const status = await (await fetch(`${url}/api/runs/${created.runId}`)).json() as ChatRunStatusResponse;
  expect(status.status).toBe('failed');
  expect(status.exitCode).toBe(0);
  expect(status.delivery?.status).toBe('failed');
  // A late browser checkpoint must not resurrect the run or erase its output.
  await post(`/api/projects/${id}/conversations/${cid}/messages/${mid}`, { id: mid, role: 'assistant', content: 'stale', runStatus: 'running' }, 'PUT');
  const response = await fetch(`${url}/api/projects/${id}/conversations/${cid}/messages`, { headers: { Accept: 'application/x-ndjson' } });
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  const transcript = JSON.parse((await response.text()).trim());
  expect(transcript.content).toBe('partial output 中文');
  expect(transcript.runStatus).toBe('failed');
  expect(transcript.delivery.status).toBe('failed');
  const history = await (await fetch(`${url}/api/projects/${id}/open-slide/versions?slideId=acceptance`)).json() as DeckVersionsResponse;
  const first = history.versions.find(version => version.reason === 'before-run')!;
  const restored = await post(`/api/projects/${id}/open-slide/versions/restore`, { slideId: 'acceptance', versionId: first.id, expectedDigest: history.currentDigest });
  expect(restored.ok).toBe(true);
  const current = await (await fetch(url + sourceUrl)).json() as { source: string };
  expect(current.source).toBe(original.source);
});
