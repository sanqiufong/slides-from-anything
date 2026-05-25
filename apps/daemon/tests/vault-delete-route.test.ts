import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

describe('Design Vault template delete route', () => {
  const previousDesignsDir = process.env.OPENPPT_VAULT_DESIGNS_DIR;
  const previousOrigin = process.env.OPENPPT_VAULT_ORIGIN;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openppt-vault-delete-'));
  const designsRoot = path.join(tmpRoot, 'designs');
  const slug = 'sample-vault-template';
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.OPENPPT_VAULT_DESIGNS_DIR = designsRoot;
    delete process.env.OPENPPT_VAULT_ORIGIN;
    fs.mkdirSync(path.join(designsRoot, slug), { recursive: true });
    fs.writeFileSync(
      path.join(designsRoot, slug, 'meta.json'),
      JSON.stringify({
        slug,
        title: 'Sample Vault Template',
        sourceUrl: 'https://example.com',
        sourceHost: 'example.com',
        sourceMode: 'url',
        status: 'ready',
        summary: 'Template used by deletion tests.',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        assets: [],
        previews: {},
      }),
    );

    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    if (previousDesignsDir === undefined) delete process.env.OPENPPT_VAULT_DESIGNS_DIR;
    else process.env.OPENPPT_VAULT_DESIGNS_DIR = previousDesignsDir;
    if (previousOrigin === undefined) delete process.env.OPENPPT_VAULT_ORIGIN;
    else process.env.OPENPPT_VAULT_ORIGIN = previousOrigin;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('removes a local Design Vault template directory', async () => {
    const response = await fetch(`${baseUrl}/api/vault/designs/${slug}`, { method: 'DELETE' });
    const json = await response.json() as { ok?: boolean; deleted?: boolean; slug?: string; removedPaths?: string[] };

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, deleted: true, slug });
    expect(json.removedPaths).toContain(path.join(designsRoot, slug));
    expect(fs.existsSync(path.join(designsRoot, slug))).toBe(false);
  });

  it('returns not found when the template is already gone', async () => {
    const response = await fetch(`${baseUrl}/api/vault/designs/${slug}`, { method: 'DELETE' });
    const json = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(404);
    expect(json.error?.code).toBe('NOT_FOUND');
  });
});
