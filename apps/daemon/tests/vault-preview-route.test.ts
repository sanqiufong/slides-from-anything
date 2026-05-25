import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { startServer } from '../src/server.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('Design Vault preview proxy', () => {
  const realFetch = globalThis.fetch;
  const previousOrigin = process.env.OPENPPT_VAULT_ORIGIN;
  const previousDesignsDir = process.env.OPENPPT_VAULT_DESIGNS_DIR;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openppt-vault-preview-'));
  const designsRoot = path.join(tmpRoot, 'designs');
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.OPENPPT_VAULT_ORIGIN = 'https://vault.example';
    process.env.OPENPPT_VAULT_DESIGNS_DIR = designsRoot;
    const localRoot = path.join(designsRoot, 'community-local-card');
    fs.mkdirSync(path.join(localRoot, 'previews'), { recursive: true });
    fs.mkdirSync(path.join(localRoot, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(localRoot, 'previews', 'card.html'),
      `<img src="/api/designs/local-card/asset/hero.png"><div style="background-image:url('/api/designs/local-card/asset/assets/bg.png')"></div>`,
    );
    fs.writeFileSync(path.join(localRoot, 'assets', 'hero.png'), 'hero');
    fs.writeFileSync(path.join(localRoot, 'assets', 'bg.png'), 'bg');
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
    if (previousDesignsDir === undefined) delete process.env.OPENPPT_VAULT_DESIGNS_DIR;
    else process.env.OPENPPT_VAULT_DESIGNS_DIR = previousDesignsDir;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rewrites local installed community preview assets to the installed slug', async () => {
    const response = await realFetch(`${baseUrl}/api/vault/designs/community-local-card/preview?kind=card`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('/api/vault/designs/community-local-card/asset?path=assets%2Fhero.png');
    expect(body).toContain('/api/vault/designs/community-local-card/asset?path=assets%2Fbg.png');
    expect(body).not.toContain('/api/vault/designs/local-card/asset');

    const assetResponse = await realFetch(`${baseUrl}/api/vault/designs/community-local-card/asset?path=assets%2Fhero.png`);
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toBe('hero');
  });

  it('forwards card preview kind and library surface to external Design Vault', async () => {
    const upstreamHtml = '<style>@keyframes dv-card-settle{from{opacity:0}to{opacity:1}}@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style><img src="/api/designs/external-card/asset/assets/logo.svg">';
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(new Response(upstreamHtml, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await realFetch(`${baseUrl}/api/vault/designs/external-card/preview?kind=card&surface=library`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://vault.example/api/designs/external-card/preview?kind=card&surface=library',
    );
    expect(body).toContain('@keyframes dv-card-settle');
    expect(body).toContain('prefers-reduced-motion');
    expect(body).toContain('/api/vault/designs/external-card/asset?path=assets%2Flogo.svg');
  });
});
