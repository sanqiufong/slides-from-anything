import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMedia } from '../src/media.js';
import { writeConfig } from '../src/media-config.js';
import { openPptDeckMediaGate } from '../src/server.js';

const OPENAI_ENV_KEYS = [
  'OD_OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'AZURE_API_KEY',
  'AZURE_OPENAI_API_KEY',
] as const;

const CASE_TITLE = 'AI数字员工内容生产与生态协同框架';
const PROJECT_ID = 'ai-digital-employee-media-loop';
const OUTPUT = 'slides/main-deck/assets/ai-digital-employee-framework.png';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

type OpenAIStubRequest = {
  url: string | undefined;
  method: string | undefined;
  authorization: string | string[] | undefined;
  body: Record<string, unknown>;
};

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startOpenAIImageStub() {
  const requests: OpenAIStubRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readRequestBody(req);
    requests.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : {},
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: PNG_1X1.toString('base64') }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to start OpenAI image stub');
  }
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('OpenPPT deck media generation loop', () => {
  let projectRoot: string;
  let homeDir: string;
  let mediaConfigDir: string;
  let openaiStub: Awaited<ReturnType<typeof startOpenAIImageStub>>;
  let originalHome: string | undefined;
  let originalMediaConfigDir: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'od-openppt-media-project-'));
    homeDir = await mkdtemp(path.join(tmpdir(), 'od-openppt-media-home-'));
    mediaConfigDir = await mkdtemp(path.join(tmpdir(), 'od-openppt-media-config-'));
    openaiStub = await startOpenAIImageStub();
    originalHome = process.env.HOME;
    originalMediaConfigDir = process.env.OD_MEDIA_CONFIG_DIR;
    originalEnv = Object.fromEntries(
      OPENAI_ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    process.env.HOME = homeDir;
    process.env.OD_MEDIA_CONFIG_DIR = mediaConfigDir;
    for (const key of OPENAI_ENV_KEYS) {
      delete process.env[key];
    }
    await writeConfig(projectRoot, {
      providers: {
        openai: {
          apiKey: 'test-openai-key',
          baseUrl: openaiStub.baseUrl,
        },
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await openaiStub.close();
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalMediaConfigDir == null) {
      delete process.env.OD_MEDIA_CONFIG_DIR;
    } else {
      process.env.OD_MEDIA_CONFIG_DIR = originalMediaConfigDir;
    }
    for (const key of OPENAI_ENV_KEYS) {
      const value = originalEnv[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
    await rm(mediaConfigDir, { recursive: true, force: true });
  });

  async function writeCodexAuth() {
    const file = path.join(homeDir, '.codex', 'auth.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        tokens: {
          access_token: 'codex-oauth-token',
          refresh_token: 'codex-refresh-token',
          account_id: 'acct_test',
        },
      }),
      'utf8',
    );
  }

  it('calls gpt-image-2, writes under slide assets, and passes the embed gate for the AI digital employee case', async () => {
    const projectsRoot = path.join(projectRoot, '.od', 'projects');
    const metadata = {
      kind: 'deck',
      deckMedia: {
        enabled: true,
        required: true,
        imageModel: 'gpt-image-2',
        imageAspect: '16:9',
      },
    };

    expect(openPptDeckMediaGate(metadata, 'export default []')).toContain(
      'does not embed any generated image file',
    );

    const file = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: PROJECT_ID,
      surface: 'image',
      model: 'gpt-image-2',
      aspect: '16:9',
      output: OUTPUT,
      prompt: `${CASE_TITLE}：关键页配图，表现内容生产、生态协同、智能体编排、跨平台分发的结构化框架。`,
    });

    expect(file).toMatchObject({
      name: OUTPUT,
      kind: 'image',
      mime: 'image/png',
      model: 'gpt-image-2',
      surface: 'image',
      providerId: 'openai',
      usedStubFallback: false,
      intentionalStub: false,
    });
    expect(openaiStub.requests).toHaveLength(1);
    const request = openaiStub.requests[0];
    expect(request).toBeDefined();
    expect(request).toMatchObject({
      url: '/v1/images/generations',
      method: 'POST',
      authorization: 'Bearer test-openai-key',
    });
    expect(request!.body).toMatchObject({
      model: 'gpt-image-2',
      size: '1792x1024',
      quality: 'high',
    });
    expect(String(request!.body.prompt)).toContain(CASE_TITLE);

    const written = await readFile(path.join(projectsRoot, PROJECT_ID, OUTPUT));
    expect(written.equals(PNG_1X1)).toBe(true);

    const slideSource = `
import type { Page, SlideMeta } from '@open-slide/core';
import keyVisual from './assets/ai-digital-employee-framework.png';

const KeyPage: Page = () => (
  <section>
    <img src={keyVisual} alt="${CASE_TITLE}关键页配图" />
  </section>
);

export const meta: SlideMeta = { title: '${CASE_TITLE}' };
export default [KeyPage] satisfies Page[];
`;

    expect(openPptDeckMediaGate(metadata, slideSource)).toBeNull();
  });

  it('blocks export for explicit pending media slots without inventing gpt-image-2', () => {
    const metadata = {
      kind: 'deck',
      deckMedia: {
        enabled: true,
        required: true,
        imageAspect: '16:9',
      },
    };

    const source = `
const PendingMedia = () => (
  <div
    data-openppt-media-status="pending"
    data-output="slides/main-deck/assets/orbitos-operating-loop.png"
    data-provider-status="400"
  />
);

export default [PendingMedia];
`;

    const gate = openPptDeckMediaGate(metadata, source);

    expect(gate).toContain('No deck media model is configured');
    expect(gate).toContain('needs media replacement');
    expect(gate).not.toContain('gpt-image-2');
  });

  it('routes Codex OAuth image generation directly through the Codex backend', async () => {
    await writeConfig(projectRoot, { providers: {}, force: true });
    await writeCodexAuth();

    const imageBase64 = PNG_1X1.toString('base64');
    const fetchMock = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/images/generations') {
        throw new Error('Codex OAuth should not call the public Images API first');
      }
      if (url === 'https://chatgpt.com/backend-api/codex/responses') {
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer codex-oauth-token',
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
                  text: 'Generate an image from this prompt:\nfallback through Codex backend',
                },
              ],
            },
          ],
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
            created_at: 123,
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
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = await generateMedia({
      projectRoot,
      projectsRoot: path.join(projectRoot, '.od', 'projects'),
      projectId: 'codex-oauth-image-fallback',
      surface: 'image',
      model: 'gpt-image-2',
      aspect: '16:9',
      output: 'slides/main-deck/assets/codex-fallback.png',
      prompt: 'fallback through Codex backend',
    });

    expect(file).toMatchObject({
      name: 'slides/main-deck/assets/codex-fallback.png',
      kind: 'image',
      mime: 'image/png',
      model: 'gpt-image-2',
      surface: 'image',
      providerId: 'openai',
      providerNote: 'codex-backend/gpt-image-2 · 16:9 · 68 bytes',
      usedStubFallback: false,
      intentionalStub: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const written = await readFile(path.join(projectRoot, '.od', 'projects', 'codex-oauth-image-fallback', file.name));
    expect(written.equals(PNG_1X1)).toBe(true);
  });

  it('surfaces Codex backend transport failures instead of a bare fetch failed', async () => {
    await writeConfig(projectRoot, { providers: {}, force: true });
    await writeCodexAuth();

    vi.stubGlobal('fetch', vi.fn(() => {
      throw new TypeError('fetch failed', { cause: new Error('Connect Timeout Error') });
    }));

    await expect(generateMedia({
      projectRoot,
      projectsRoot: path.join(projectRoot, '.od', 'projects'),
      projectId: 'codex-oauth-image-failure',
      surface: 'image',
      model: 'gpt-image-2',
      aspect: '16:9',
      output: 'slides/main-deck/assets/codex-failure.png',
      prompt: 'backend fails clearly',
    })).rejects.toMatchObject({
      status: 502,
      code: 'CODEX_IMAGE_BACKEND_FAILED',
      message: expect.stringContaining('Codex image backend failed for gpt-image-2: fetch failed (Connect Timeout Error)'),
    });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
