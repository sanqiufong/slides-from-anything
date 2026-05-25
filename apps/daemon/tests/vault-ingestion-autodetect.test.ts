import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { startServer } from '../src/server.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('Design Vault ingestion autodetect', () => {
  const realFetch = globalThis.fetch;
  const previousOrigin = process.env.OPENPPT_VAULT_ORIGIN;
  const previousDesignVaultOrigin = process.env.DESIGN_VAULT_ORIGIN;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openppt-vault-autodetect-'));
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    delete process.env.OPENPPT_VAULT_ORIGIN;
    delete process.env.DESIGN_VAULT_ORIGIN;
    process.env.XDG_CONFIG_HOME = path.join(tmpRoot, 'config');
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (previousOrigin === undefined) delete process.env.OPENPPT_VAULT_ORIGIN;
    else process.env.OPENPPT_VAULT_ORIGIN = previousOrigin;
    if (previousDesignVaultOrigin === undefined) delete process.env.DESIGN_VAULT_ORIGIN;
    else process.env.DESIGN_VAULT_ORIGIN = previousDesignVaultOrigin;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('probes the default live vault before reporting embedded mode or rejecting ingestion', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      if (url === 'http://127.0.0.1:3217/api/health') {
        return Promise.resolve(Response.json({
          ok: true,
          service: 'design-vault',
          version: '0.1.0',
          spec: 'open-design/vault@v1',
          capabilities: ['ingest:url'],
        }));
      }
      if (url === 'http://127.0.0.1:3217/api/ingestions') {
        return Promise.resolve(Response.json({
          id: 'live-job',
          status: 'queued',
          url: 'https://example.com',
          mode: 'url',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const statusResponse = await realFetch(`${baseUrl}/api/vault/status`);
    const status = await statusResponse.json() as { mode?: string; ingestionAvailable?: boolean };
    expect(status).toMatchObject({ mode: 'external', ingestionAvailable: true });

    const response = await realFetch(`${baseUrl}/api/vault/ingestions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', mode: 'url' }),
    });
    const json = await response.json() as { job?: { id?: string; status?: string; error?: string } };

    expect(response.status).toBe(200);
    expect(json.job).toMatchObject({ id: 'live-job', status: 'queued' });
    expect(json.job?.error).toBeUndefined();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === 'http://127.0.0.1:3217/api/health')).toBe(true);
    expect(fetchMock.mock.calls.some(([input, init]) => {
      return String(input) === 'http://127.0.0.1:3217/api/ingestions' && init?.method === 'POST';
    })).toBe(true);
  });
});
