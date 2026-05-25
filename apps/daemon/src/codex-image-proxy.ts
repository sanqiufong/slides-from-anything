import type { Request, Response } from 'express';
import { resolveOpenAIOAuthCredential } from './media-config.js';

const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_CODEX_RESPONSES_MODEL = 'gpt-5.2';

type FetchLike = typeof fetch;

export type CodexImageProxyStatus = {
  enabled: boolean;
  baseUrl: string;
  endpoint: '/images/generations';
  defaultModel: string;
  auth: {
    configured: boolean;
    source: string;
    accountIdConfigured: boolean;
    accountIdTail: string;
  };
  proxyKey: {
    enabled: boolean;
    env: 'OD_CODEX_IMAGE_PROXY_KEY';
  };
  backend: {
    forceCodexBackend: boolean;
    useResponsesTool: boolean;
    responsesModel: string;
  };
};

type ImageGenerationRequest = {
  model: string;
  prompt: string;
  n: number;
  size: string | undefined;
  quality: string | undefined;
  responseFormat: string | undefined;
  raw: Record<string, unknown>;
};

class ImageProxyError extends Error {
  status: number;
  code: string;
  type: string;
  param: string | undefined;

  constructor(status: number, code: string, message: string, type = 'invalid_request_error', param?: string) {
    super(message);
    this.name = 'ImageProxyError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.param = param;
  }
}

class UpstreamImageError extends Error {
  status: number;
  body: string;
  upstream: string;

  constructor(upstream: string, status: number, body: string) {
    super(`${upstream} ${status}: ${truncate(body, 300)}`);
    this.name = 'UpstreamImageError';
    this.upstream = upstream;
    this.status = status;
    this.body = body;
  }
}

export async function handleCodexImageGenerationsRequest(
  req: Request,
  res: Response,
  options: { projectRoot: string; fetchImpl?: FetchLike } = { projectRoot: process.cwd() },
) {
  try {
    assertProxyAuth(req);
    const imageRequest = normalizeImageRequest(req.body);
    const credential = await resolveOpenAIOAuthCredential();
    if (!credential?.apiKey) {
      throw new ImageProxyError(
        503,
        'codex_auth_missing',
        'No Codex/OpenAI credential found. Run Codex login or configure OPENAI_API_KEY.',
      );
    }

    const fetchImpl = options.fetchImpl || fetch;
    const forceCodexBackend = process.env.OD_CODEX_IMAGE_FORCE_BACKEND === '1';
    let directError: unknown = null;

    if (!forceCodexBackend) {
      try {
        const direct = await callOpenAIImages(fetchImpl, imageRequest, credential);
        return res.json(direct);
      } catch (err) {
        directError = err;
      }
    }

    if (!credential.accountId) {
      const suffix = directError ? ` Direct image API failed: ${errorMessage(directError)}` : '';
      throw new ImageProxyError(
        502,
        'codex_account_missing',
        `Codex account_id is required for backend fallback.${suffix}`,
      );
    }

    const fallback = await callCodexResponsesBackend(fetchImpl, imageRequest, credential, directError);
    return res.json(fallback);
  } catch (err) {
    return sendOpenAIError(res, err);
  }
}

export async function getCodexImageProxyStatus(baseUrl: string): Promise<CodexImageProxyStatus> {
  const credential = await resolveOpenAIOAuthCredential();
  const accountId =
    typeof credential?.accountId === 'string' ? credential.accountId.trim() : '';
  return {
    enabled: true,
    baseUrl: `${baseUrl.replace(/\/+$/, '')}/v1`,
    endpoint: '/images/generations',
    defaultModel: DEFAULT_IMAGE_MODEL,
    auth: {
      configured: Boolean(credential?.apiKey),
      source: credential?.source || 'unset',
      accountIdConfigured: Boolean(accountId),
      accountIdTail: tail(accountId),
    },
    proxyKey: {
      enabled: Boolean(process.env.OD_CODEX_IMAGE_PROXY_KEY?.trim()),
      env: 'OD_CODEX_IMAGE_PROXY_KEY',
    },
    backend: {
      forceCodexBackend: process.env.OD_CODEX_IMAGE_FORCE_BACKEND === '1',
      useResponsesTool: process.env.OD_CODEX_IMAGE_USE_TOOL === '1',
      responsesModel: process.env.OD_CODEX_IMAGE_RESPONSES_MODEL?.trim() || DEFAULT_CODEX_RESPONSES_MODEL,
    },
  };
}

export async function generateCodexImageWithOAuth({
  credential,
  prompt,
  model = DEFAULT_IMAGE_MODEL,
  n = 1,
  size,
  quality,
  fetchImpl = fetch,
  directError = null,
}: {
  credential: any;
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  quality?: string;
  fetchImpl?: FetchLike;
  directError?: unknown;
}) {
  if (!credential?.apiKey) {
    throw new ImageProxyError(
      503,
      'codex_auth_missing',
      'No Codex/OpenAI credential found. Run Codex login or configure OPENAI_API_KEY.',
    );
  }
  if (!credential.accountId) {
    throw new ImageProxyError(
      502,
      'codex_account_missing',
      'Codex account_id is required for backend image generation.',
    );
  }

  return callCodexResponsesBackend(
    fetchImpl,
    {
      model,
      prompt,
      n,
      size,
      quality,
      responseFormat: undefined,
      raw: {
        model,
        prompt,
        n,
        ...(size ? { size } : {}),
        ...(quality ? { quality } : {}),
      },
    },
    credential,
    directError,
  );
}

function assertProxyAuth(req: Request) {
  const expected = process.env.OD_CODEX_IMAGE_PROXY_KEY?.trim();
  if (!expected) return;

  const auth = String(req.headers.authorization || '').trim();
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  if (auth === `Bearer ${expected}` || apiKey === expected) return;

  throw new ImageProxyError(401, 'invalid_api_key', 'Invalid Codex image proxy API key.', 'authentication_error');
}

function normalizeImageRequest(body: unknown): ImageGenerationRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ImageProxyError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  const raw = body as Record<string, unknown>;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) {
    throw new ImageProxyError(400, 'missing_prompt', 'prompt is required.', 'invalid_request_error', 'prompt');
  }

  const model = typeof raw.model === 'string' && raw.model.trim()
    ? raw.model.trim()
    : DEFAULT_IMAGE_MODEL;
  const n = normalizeCount(raw.n);
  const size = typeof raw.size === 'string' && raw.size.trim() ? raw.size.trim() : undefined;
  const quality = typeof raw.quality === 'string' && raw.quality.trim() ? raw.quality.trim() : undefined;
  const responseFormat =
    typeof raw.response_format === 'string' && raw.response_format.trim()
      ? raw.response_format.trim()
      : undefined;

  return { model, prompt, n, size, quality, responseFormat, raw };
}

function normalizeCount(value: unknown) {
  if (value == null || value === '') return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new ImageProxyError(400, 'invalid_n', 'n must be an integer from 1 to 10.', 'invalid_request_error', 'n');
  }
  return n;
}

async function callOpenAIImages(fetchImpl: FetchLike, request: ImageGenerationRequest, credential: any) {
  const body = buildOpenAIImageBody(request);
  const resp = await fetchImpl(OPENAI_IMAGES_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential.apiKey}`,
      'content-type': 'application/json',
      ...(credential.accountId ? { 'chatgpt-account-id': credential.accountId } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new UpstreamImageError('openai-images', resp.status, text);
  }
  const payload = parseJson(text, 'openai image response');
  return normalizeOpenAIImagesResponse(fetchImpl, payload);
}

function buildOpenAIImageBody(request: ImageGenerationRequest) {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    n: request.n,
  };

  for (const key of [
    'size',
    'quality',
    'style',
    'user',
    'background',
    'moderation',
    'output_format',
    'output_compression',
    'partial_images',
  ]) {
    const value = request.raw[key];
    if (value !== undefined && value !== null && value !== '') body[key] = value;
  }

  if (!request.model.startsWith('gpt-image-') && request.responseFormat) {
    body.response_format = request.responseFormat;
  }

  return body;
}

async function normalizeOpenAIImagesResponse(fetchImpl: FetchLike, payload: any) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  if (data.length === 0) {
    throw new ImageProxyError(502, 'empty_image_response', 'Upstream image response did not contain data.');
  }

  const out = [];
  for (const item of data) {
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      out.push({
        b64_json: item.b64_json,
        ...(typeof item.revised_prompt === 'string' ? { revised_prompt: item.revised_prompt } : {}),
      });
      continue;
    }
    if (typeof item?.url === 'string' && item.url) {
      const img = await fetchImpl(item.url);
      if (!img.ok) {
        throw new UpstreamImageError('openai-image-url', img.status, await img.text());
      }
      const bytes = Buffer.from(await img.arrayBuffer());
      out.push({
        b64_json: bytes.toString('base64'),
        ...(typeof item.revised_prompt === 'string' ? { revised_prompt: item.revised_prompt } : {}),
      });
    }
  }

  if (out.length === 0) {
    throw new ImageProxyError(502, 'missing_image_data', 'Upstream image response had neither b64_json nor url.');
  }

  return {
    created: Number.isFinite(payload?.created) ? payload.created : Math.floor(Date.now() / 1000),
    data: out,
    ...(payload?.usage ? { usage: payload.usage } : {}),
  };
}

async function callCodexResponsesBackend(
  fetchImpl: FetchLike,
  request: ImageGenerationRequest,
  credential: any,
  directError: unknown,
) {
  const images: string[] = [];
  let created = Math.floor(Date.now() / 1000);
  let lastPayload: any = null;

  for (let i = 0; i < request.n; i += 1) {
    const resp = await fetchImpl(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.apiKey}`,
        'chatgpt-account-id': credential.accountId,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'openai-beta': 'responses=experimental',
        originator: 'codex_cli_rs',
      },
      body: JSON.stringify(buildCodexResponsesBody(request)),
    });
    if (!resp.ok) {
      const text = await resp.text();
      const prefix = directError ? `Direct image API failed first: ${errorMessage(directError)}; ` : '';
      throw new UpstreamImageError('codex-responses', resp.status, `${prefix}${text}`);
    }
    const payloads = await readCodexResponsePayloads(resp);
    for (const payload of payloads) {
      lastPayload = payload;
      if (Number.isFinite(payload?.created_at)) created = payload.created_at;
      images.push(...collectBase64Images(payload));
    }
    if (images.length >= request.n) break;
  }

  if (images.length === 0) {
    const prefix = directError ? `Direct image API failed first: ${errorMessage(directError)}; ` : '';
    throw new ImageProxyError(
      502,
      'missing_codex_image',
      `${prefix}Codex backend response did not contain an image_generation result.`,
    );
  }

  return {
    created,
    data: images.slice(0, request.n).map((b64) => ({ b64_json: b64 })),
    ...(lastPayload?.usage ? { usage: lastPayload.usage } : {}),
  };
}

function buildCodexResponsesBody(request: ImageGenerationRequest) {
  const responsesModel = process.env.OD_CODEX_IMAGE_RESPONSES_MODEL?.trim() || DEFAULT_CODEX_RESPONSES_MODEL;
  const body: Record<string, unknown> = {
    model: responsesModel,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Generate an image from this prompt:\n${request.prompt}`,
          },
        ],
      },
    ],
    instructions: '',
    store: false,
    stream: true,
  };

  const imageOptions: Record<string, unknown> = {};
  if (request.size) imageOptions.size = request.size;
  if (request.quality) imageOptions.quality = normalizeResponsesQuality(request.quality);

  const tool: Record<string, unknown> = {
    type: 'image_generation',
    model: request.model,
    ...imageOptions,
  };
  body.tools = [tool];

  return body;
}

function normalizeResponsesQuality(quality: string) {
  if (quality === 'hd') return 'high';
  if (quality === 'standard') return 'medium';
  return quality;
}

function collectBase64Images(value: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();

  function visit(node: unknown, imageContext: boolean) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : '';
    const nextImageContext = imageContext || type.includes('image');

    for (const key of ['b64_json', 'partial_image_b64', 'result']) {
      const candidate = obj[key];
      if (nextImageContext && typeof candidate === 'string' && looksLikeBase64Image(candidate)) {
        found.push(stripDataUrl(candidate));
      }
    }

    for (const child of Object.values(obj)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item, nextImageContext);
      } else {
        visit(child, nextImageContext);
      }
    }
  }

  visit(value, false);
  return Array.from(new Set(found));
}

function looksLikeBase64Image(value: string) {
  const stripped = stripDataUrl(value);
  return stripped.length > 80 && /^[A-Za-z0-9+/=_-]+$/.test(stripped);
}

function stripDataUrl(value: string) {
  const idx = value.indexOf(',');
  return value.startsWith('data:image/') && idx >= 0 ? value.slice(idx + 1) : value;
}

function parseJson(text: string, label: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImageProxyError(502, 'bad_upstream_json', `${label} was not valid JSON: ${truncate(text, 200)}`);
  }
}

function parseCodexResponsePayloads(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith('data:') && !trimmed.includes('\ndata:')) {
    return [parseJson(trimmed, 'codex responses image response')];
  }

  const payloads = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    payloads.push(parseJson(data, 'codex responses stream event'));
  }
  return payloads;
}

async function readCodexResponsePayloads(resp: any) {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    return parseCodexResponsePayloads(await resp.text());
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const payloads: unknown[] = [];
  let buffer = '';

  function consumeFrames(flush = false) {
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice((match.index ?? 0) + match[0].length);
      pushFramePayloads(frame, payloads);
    }
    if (flush && buffer.trim()) {
      pushFramePayloads(buffer, payloads);
      buffer = '';
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeFrames(false);
    }
    buffer += decoder.decode();
    consumeFrames(true);
  } catch (err) {
    buffer += decoder.decode();
    consumeFrames(true);
    if (payloads.some((payload) => collectBase64Images(payload).length > 0)) {
      return payloads;
    }
    throw err;
  }

  return payloads;
}

function pushFramePayloads(frame: string, payloads: unknown[]) {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((line) => line && line !== '[DONE]');
  for (const data of dataLines) {
    payloads.push(parseJson(data, 'codex responses stream event'));
  }
}

function sendOpenAIError(res: Response, err: unknown) {
  const status =
    err instanceof ImageProxyError
      ? err.status
      : err instanceof UpstreamImageError
        ? 502
        : 500;
  const code =
    err instanceof ImageProxyError
      ? err.code
      : err instanceof UpstreamImageError
        ? 'upstream_error'
        : 'internal_error';
  const type =
    err instanceof ImageProxyError
      ? err.type
      : err instanceof UpstreamImageError
        ? 'server_error'
        : 'server_error';

  return res.status(status).json({
    error: {
      message: errorMessage(err),
      type,
      code,
      ...(err instanceof ImageProxyError && err.param ? { param: err.param } : {}),
    },
  });
}

function errorMessage(err: unknown) {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error && cause.message && !err.message.includes(cause.message)) {
    return `${err.message} (${cause.message})`;
  }
  if (cause && typeof cause === 'object' && 'code' in cause && !err.message.includes(String(cause.code))) {
    return `${err.message} (${String(cause.code)})`;
  }
  return err.message;
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function tail(value: string) {
  return value ? value.slice(-6) : '';
}
