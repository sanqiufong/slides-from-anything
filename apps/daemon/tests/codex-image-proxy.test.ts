import type http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/server.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('Codex image proxy', () => {
  const realFetch = globalThis.fetch;
  const originalHome = process.env.HOME;
  const originalForceBackend = process.env.OD_CODEX_IMAGE_FORCE_BACKEND;
  const originalProxyKey = process.env.OD_CODEX_IMAGE_PROXY_KEY;
  let homeDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), 'od-codex-image-home-'));
    process.env.HOME = homeDir;
    delete process.env.OD_CODEX_IMAGE_FORCE_BACKEND;
    delete process.env.OD_CODEX_IMAGE_PROXY_KEY;
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalForceBackend == null) {
      delete process.env.OD_CODEX_IMAGE_FORCE_BACKEND;
    } else {
      process.env.OD_CODEX_IMAGE_FORCE_BACKEND = originalForceBackend;
    }
    if (originalProxyKey == null) {
      delete process.env.OD_CODEX_IMAGE_PROXY_KEY;
    } else {
      process.env.OD_CODEX_IMAGE_PROXY_KEY = originalProxyKey;
    }
  });

  async function writeCodexAuth() {
    const file = path.join(homeDir, '.codex', 'auth.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        tokens: {
          access_token: 'codex-access-token',
          refresh_token: 'codex-refresh-token',
          account_id: 'acct_test',
        },
      }),
      'utf8',
    );
  }

  it('exposes an OpenAI-compatible /v1/images/generations route using Codex auth', async () => {
    await writeCodexAuth();
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      expect(url).toBe('https://api.openai.com/v1/images/generations');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer codex-access-token',
        'chatgpt-account-id': 'acct_test',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'gpt-image-2',
        prompt: 'make a clean product image',
        n: 1,
        size: '1024x1024',
      });
      return Promise.resolve(jsonResponse({ created: 123, data: [{ b64_json: 'image-b64' }] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'make a clean product image',
        size: '1024x1024',
        response_format: 'b64_json',
      }),
    });

    await expect(res.json()).resolves.toEqual({
      created: 123,
      data: [{ b64_json: 'image-b64' }],
    });
  });

  it('reports Settings status without exposing the Codex token', async () => {
    await writeCodexAuth();
    process.env.OD_CODEX_IMAGE_PROXY_KEY = 'proxy-secret';

    const res = await realFetch(`${baseUrl}/api/codex-image-proxy/status`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      enabled: true,
      baseUrl: `${baseUrl}/v1`,
      endpoint: '/images/generations',
      defaultModel: 'gpt-image-2',
      auth: {
        configured: true,
        source: 'oauth-codex',
        accountIdConfigured: true,
        accountIdTail: 't_test',
      },
      proxyKey: {
        enabled: true,
        env: 'OD_CODEX_IMAGE_PROXY_KEY',
      },
    });
    expect(JSON.stringify(body)).not.toContain('codex-access-token');
    expect(JSON.stringify(body)).not.toContain('acct_test');
  });

  it('falls back to the Codex responses backend when the direct image API fails', async () => {
    await writeCodexAuth();
    const imageBase64 = Buffer.from('fake-image-bytes'.repeat(8)).toString('base64');
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      if (url === 'https://api.openai.com/v1/images/generations') {
        return Promise.resolve(jsonResponse({ error: { message: 'unauthorized' } }, 401));
      }
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer codex-access-token',
        'chatgpt-account-id': 'acct_test',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-5.2',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Generate an image from this prompt:\nfallback please',
              },
            ],
          },
        ],
        instructions: '',
        store: false,
        stream: true,
        tools: [
          {
            type: 'image_generation',
            model: 'gpt-image-2',
          },
        ],
      });
      return Promise.resolve(new Response([
        `data: ${JSON.stringify({
          created_at: 456,
          output: [
            {
              type: 'image_generation_call',
              result: imageBase64,
            },
          ],
        })}`,
        'data: [DONE]',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'fallback please',
      }),
    });

    await expect(res.json()).resolves.toEqual({
      created: 456,
      data: [{ b64_json: imageBase64 }],
    });
  });

  it('can require a local proxy API key while keeping the upstream Codex token private', async () => {
    await writeCodexAuth();
    process.env.OD_CODEX_IMAGE_PROXY_KEY = 'proxy-secret';
    const res = await realFetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ prompt: 'blocked' }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'invalid_api_key' },
    });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
