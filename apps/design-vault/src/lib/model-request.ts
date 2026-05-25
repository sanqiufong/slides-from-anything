const DEFAULT_REFERER = "http://localhost:3217";

export type ModelRequestDiagnostics = {
  label: string;
  endpoint: string;
  model?: string;
  timeoutMs: number;
  retries: number;
  attempts: number;
  maxTokens?: number;
  thinking?: "disabled" | "provider-default";
  reasoning?: "disabled" | "provider-default";
  responseFormat?: "json_object" | "prompt-only";
  requestChars: number;
  estimatedInputTokens: {
    charsPerToken4: number;
    charsPerToken3: number;
  };
  messageChars?: number[];
  mediaInputCount?: number;
  evidenceChars?: number;
  evidenceFieldChars?: Record<string, number>;
  promptVersion?: string;
  createdAt: string;
  durationMs?: number;
  httpStatus?: number;
  errorParts?: string[];
  responseChars?: number;
  responsePreview?: string;
  finishReason?: string;
  nativeFinishReason?: string;
  messageContentChars?: number;
  usage?: unknown;
  jsonRecovery?: {
    method: string;
    originalChars: number;
    candidateChars: number;
    error?: string;
  };
};

export class ModelRequestError extends Error {
  diagnostics?: ModelRequestDiagnostics;

  constructor(message: string, diagnostics?: ModelRequestDiagnostics) {
    super(message);
    this.name = "ModelRequestError";
    this.diagnostics = diagnostics;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(baseMs: number, attempt: number) {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.round(baseMs * 0.25 * Math.random());
  return Math.min(20_000, exponential + jitter);
}

function isRetryableStatus(status: number) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function errorCauseParts(error: unknown, timeoutMs?: number) {
  const parts: string[] = [];
  if (error instanceof Error) {
    if ((error.name === "AbortError" || error.name === "TimeoutError") && timeoutMs) {
      parts.push(`request timed out after ${timeoutMs}ms`);
    }
    parts.push(error.name, error.message);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const record = cause as Record<string, unknown>;
      for (const key of ["code", "errno", "syscall", "hostname", "address", "port"]) {
        const value = record[key];
        if (typeof value === "string" || typeof value === "number") {
          parts.push(`${key}=${value}`);
        }
      }
    }
  } else if (error !== undefined) {
    parts.push(String(error));
  }

  return [...new Set(parts.filter(Boolean))];
}

function bodyText(body: BodyInit | null | undefined) {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return "";
}

function requestChars(body: unknown) {
  if (typeof body === "string") return body.length;
  return JSON.stringify(body)?.length ?? 0;
}

function estimatedInputTokens(chars: number) {
  return {
    charsPerToken4: Math.ceil(chars / 4),
    charsPerToken3: Math.ceil(chars / 3),
  };
}

function jsonSize(value: unknown) {
  return JSON.stringify(value)?.length ?? 0;
}

export function isKimiK2Model(model: string) {
  return /(^|[/:_-])kimi[-_]?k2(?:[.-]?\d+)?$/i.test(model.trim()) || /(^|[/:_-])kimi[-_]?k2[.-]?\d+/i.test(model.trim());
}

export function modelTemperatureControl(model: string, temperature: number) {
  return isKimiK2Model(model) ? {} : { temperature };
}

function isOpenRouterLikeEndpoint(baseUrl?: string) {
  return /openrouter\.ai|opencode\.ai\/zen/i.test(baseUrl ?? "");
}

export function modelGenerationControls(model: string, maxTokens: number, baseUrl?: string) {
  return {
    max_tokens: maxTokens,
    ...(isKimiK2Model(model) ? { thinking: { type: "disabled" } } : {}),
    ...(isKimiK2Model(model) && isOpenRouterLikeEndpoint(baseUrl)
      ? {
          reasoning: { effort: "none", exclude: true },
          include_reasoning: false,
        }
      : {}),
  };
}

export function modelJsonResponseControl(model: string) {
  return isKimiK2Model(model) ? {} : { response_format: { type: "json_object" } };
}

export function buildModelRequestDiagnostics(input: {
  label: string;
  endpoint: string;
  model?: string;
  body: unknown;
  timeoutMs: number;
  retries?: number;
  maxTokens?: number;
  promptVersion?: string;
  evidence?: unknown;
  messageContents?: string[];
  mediaInputCount?: number;
}): ModelRequestDiagnostics {
  const chars = requestChars(input.body);
  const evidence = input.evidence as Record<string, unknown> | undefined;
  return {
    label: input.label,
    endpoint: input.endpoint,
    model: input.model,
    timeoutMs: input.timeoutMs,
    retries: input.retries ?? 0,
    attempts: Math.max(1, (input.retries ?? 0) + 1),
    maxTokens: input.maxTokens,
    thinking: input.model && isKimiK2Model(input.model) ? "disabled" : "provider-default",
    reasoning: input.model && isKimiK2Model(input.model) && isOpenRouterLikeEndpoint(input.endpoint) ? "disabled" : "provider-default",
    responseFormat: input.model && isKimiK2Model(input.model) ? "prompt-only" : "json_object",
    requestChars: chars,
    estimatedInputTokens: estimatedInputTokens(chars),
    messageChars: input.messageContents?.map((content) => content.length),
    mediaInputCount: input.mediaInputCount,
    evidenceChars: input.evidence ? jsonSize(input.evidence) : undefined,
    evidenceFieldChars: evidence && typeof evidence === "object"
      ? Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, jsonSize(value)]))
      : undefined,
    promptVersion: input.promptVersion,
    createdAt: new Date().toISOString(),
  };
}

export function getModelRequestDiagnostics(error: unknown): ModelRequestDiagnostics | undefined {
  if (error instanceof ModelRequestError) return error.diagnostics;
  const candidate = error as { diagnostics?: unknown };
  if (candidate && typeof candidate === "object" && candidate.diagnostics) return candidate.diagnostics as ModelRequestDiagnostics;
  return undefined;
}

export function withModelRequestDiagnostics(message: string, diagnostics?: ModelRequestDiagnostics) {
  return new ModelRequestError(message, diagnostics);
}

export function chatCompletionsUrl(baseUrl: string) {
  return `${baseUrl.trim().replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "")}/chat/completions`;
}

export function modelRequestHeaders(apiKey: string): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": process.env.DESIGN_VAULT_APP_URL || DEFAULT_REFERER,
    "X-Title": "Design Vault",
  };
}

export function describeModelFetchFailure(error: unknown, endpoint: string, attempts: number, label = "Model request failed", timeoutMs?: number) {
  const details = errorCauseParts(error, timeoutMs).join(" · ") || "unknown network error";
  return `${label}: network request failed after ${attempts} attempt${attempts === 1 ? "" : "s"} at ${endpoint} · ${details}`;
}

export async function fetchModelEndpoint(
  endpoint: string,
  init: Omit<RequestInit, "signal">,
  options: {
    timeoutMs: number;
    retries?: number;
    retryDelayMs?: number;
    failureLabel?: string;
    diagnostics?: ModelRequestDiagnostics;
  },
) {
  const attempts = Math.max(1, (options.retries ?? 0) + 1);
  let lastError: unknown;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(endpoint, {
        ...init,
        signal: controller.signal,
      });
      if (isRetryableStatus(response.status) && attempt < attempts) {
        lastError = new Error(`HTTP ${response.status}`);
        await response.arrayBuffer().catch(() => undefined);
        await delay(retryDelay(options.retryDelayMs ?? 1000, attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(retryDelay(options.retryDelayMs ?? 1000, attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const errorParts = errorCauseParts(lastError, options.timeoutMs);
  throw new ModelRequestError(describeModelFetchFailure(lastError, endpoint, attempts, options.failureLabel, options.timeoutMs), {
    label: options.failureLabel ?? "Model request failed",
    endpoint,
    timeoutMs: options.timeoutMs,
    retries: options.retries ?? 0,
    attempts,
    requestChars: requestChars(bodyText(init.body)),
    estimatedInputTokens: estimatedInputTokens(requestChars(bodyText(init.body))),
    createdAt: new Date().toISOString(),
    ...options.diagnostics,
    durationMs: Date.now() - startedAt,
    errorParts,
  });
}
