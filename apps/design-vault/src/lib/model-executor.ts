import { runCliCompletion, type CliChatMessage } from "./cli-executor";
import { getModelRuntimeConfig, loadLocalModelEnv, type ModelRuntimeConfig } from "./model-config";
import { chatCompletionsUrl, fetchModelEndpoint, modelRequestHeaders } from "./model-request";

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type RunChatCompletionInput = {
  messages: ChatMessage[];
  temperature?: number;
  /** Ask the underlying backend to produce a single JSON object. Default true. */
  jsonOutput?: boolean;
  /** BYOK only: timeout for the HTTP call. Overrides the env-configured timeout. */
  timeoutMs?: number;
  /** BYOK only: retry count for the HTTP call. */
  retries?: number;
  retryDelayMs?: number;
  failureLabel?: string;
};

export type RunChatCompletionResult = {
  content: string;
  model: string;
  mode: "local-cli" | "byok";
  /** "openai-compatible" for BYOK, or `local-cli:<agentId>` for local CLI execution. */
  provider: string;
  durationMs: number;
};

export class ModelNotConfiguredError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "ModelNotConfiguredError";
  }
}

function toCliMessages(messages: ChatMessage[]): CliChatMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

/**
 * Unified entry point for all model calls. Routes to the local CLI subprocess in
 * "local-cli" mode and to the OpenAI-compatible HTTP endpoint in "byok" mode.
 */
export async function runChatCompletion(input: RunChatCompletionInput): Promise<RunChatCompletionResult> {
  loadLocalModelEnv();
  const config = getModelRuntimeConfig();
  if (!config.configured) throw notConfigured(config);

  const failureLabel = input.failureLabel ?? "Model request failed";
  const jsonOutput = input.jsonOutput ?? true;

  if (config.mode === "local-cli") {
    if (!config.localCli) throw notConfigured(config);
    const result = await runCliCompletion({
      agentId: config.localCli.agentId,
      model: config.localCli.model,
      messages: toCliMessages(input.messages),
      jsonOutput,
      timeoutMs: input.timeoutMs ?? config.timeoutMs,
      failureLabel,
    });
    return {
      content: result.content,
      model: result.model,
      mode: "local-cli",
      provider: `local-cli:${result.agentId}`,
      durationMs: result.durationMs,
    };
  }

  const startedAt = Date.now();
  const endpoint = chatCompletionsUrl(config.baseUrl);
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: input.temperature ?? 0.2,
    messages: input.messages,
  };
  if (jsonOutput) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetchModelEndpoint(
    endpoint,
    {
      method: "POST",
      headers: modelRequestHeaders(process.env.DESIGN_VAULT_MODEL_API_KEY ?? ""),
      body: JSON.stringify(body),
    },
    {
      timeoutMs: input.timeoutMs ?? config.timeoutMs,
      retries: input.retries,
      retryDelayMs: input.retryDelayMs,
      failureLabel,
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${failureLabel}: HTTP ${response.status}${detail ? ` · ${detail.slice(0, 600)}` : ""}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`${failureLabel}: model returned empty content.`);
  }

  return {
    content,
    model: config.model,
    mode: "byok",
    provider: "openai-compatible",
    durationMs: Date.now() - startedAt,
  };
}

function notConfigured(config: ModelRuntimeConfig): ModelNotConfiguredError {
  const reason =
    config.mode === "local-cli"
      ? "Local CLI mode is selected, but no CLI agent is configured. Pick a CLI in the model settings."
      : "DESIGN_VAULT_MODEL_BASE_URL and DESIGN_VAULT_MODEL_API_KEY are not both configured.";
  return new ModelNotConfiguredError(reason);
}

export function isModelConfigured(): boolean {
  loadLocalModelEnv();
  return getModelRuntimeConfig().configured;
}
