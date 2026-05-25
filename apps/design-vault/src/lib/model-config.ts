import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { delimiter } from "node:path";
import { promisify } from "node:util";

import { APP_ROOT } from "./storage";
import { isSupportedAgentId, runCliCompletion, SUPPORTED_AGENT_IDS, type SupportedAgentId } from "./cli-executor";
import { chatCompletionsUrl, describeModelFetchFailure, modelGenerationControls, modelJsonResponseControl, modelRequestHeaders, modelTemperatureControl } from "./model-request";

const execFileP = promisify(execFile);

export const MODEL_ENV_PATH = path.join(APP_ROOT, ".env.local");

const MODEL_ENV_KEYS = [
  "DESIGN_VAULT_MODEL_BASE_URL",
  "DESIGN_VAULT_MODEL_API_KEY",
  "DESIGN_VAULT_MODEL_NAME",
  "DESIGN_VAULT_MODEL_TIMEOUT_MS",
  "DESIGN_VAULT_REQUIRE_MODEL",
  "DESIGN_VAULT_EXECUTION_MODE",
  "DESIGN_VAULT_CLI_AGENT",
  "DESIGN_VAULT_CLI_MODEL",
] as const;

export type ExecutionMode = "local-cli" | "byok";
const EXECUTION_MODES: readonly ExecutionMode[] = ["local-cli", "byok"];

function normalizeExecutionMode(value: string | undefined): ExecutionMode {
  return value === "local-cli" ? "local-cli" : "byok";
}

const ALLOWED_SECRET_ENV_NAMES = new Set([
  "DESIGN_VAULT_MODEL_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MOONSHOT_API_KEY",
  "DASHSCOPE_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
]);

type ModelEnvKey = (typeof MODEL_ENV_KEYS)[number];

export type LocalModelOption = {
  id: string;
  label: string;
};

export type DetectedAgent = {
  id: string;
  name: string;
  bin: string;
  available: boolean;
  path?: string;
  version?: string;
  models: LocalModelOption[];
};

export type EndpointCandidate = {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  model: string;
  source: "current" | "preset" | "environment" | "local-cli";
  keyEnvName?: string;
  keyAvailable: boolean;
};

export type LocalCliSelection = {
  agentId: SupportedAgentId;
  model: string;
};

export type ModelRuntimeConfig = {
  configured: boolean;
  mode: ExecutionMode;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  requireModel: boolean;
  apiKeyConfigured: boolean;
  apiKeyMasked?: string;
  apiKeySource?: string;
  envLocalPath: string;
  localCli: LocalCliSelection | null;
};

export type ModelRuntimeScan = {
  config: ModelRuntimeConfig;
  agents: DetectedAgent[];
  endpointCandidates: EndpointCandidate[];
  pathDirs: string[];
};

export type SaveModelConfigInput = {
  mode?: ExecutionMode;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnvName?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
  requireModel?: boolean;
  cliAgent?: string;
  cliModel?: string;
};

type AgentDef = {
  id: string;
  name: string;
  bin: string;
  versionArgs: string[];
  listModels?: {
    args: string[];
    timeoutMs: number;
    parse: (stdout: string) => LocalModelOption[] | null;
  };
  fallbackModels: LocalModelOption[];
};

const DEFAULT_MODEL: LocalModelOption = { id: "default", label: "Default" };

const AGENT_DEFS: AgentDef[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku" },
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    bin: "codex",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "gpt-5.5", label: "gpt-5.5" },
      { id: "gpt-5.4", label: "gpt-5.4" },
      { id: "gpt-5-codex", label: "gpt-5-codex" },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    versionArgs: ["--version"],
    listModels: {
      args: ["models"],
      timeoutMs: 8000,
      parse: parseLineSeparatedModels,
    },
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
      { id: "openai/gpt-5", label: "openai/gpt-5" },
    ],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    bin: "gemini",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
      { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    ],
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    bin: "kimi",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "kimi-k2.6", label: "kimi-k2.6" },
      { id: "kimi-k2.5", label: "kimi-k2.5" },
    ],
  },
  {
    id: "qwen",
    name: "Qwen Code",
    bin: "qwen",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "qwen3.6-plus", label: "qwen3.6-plus" },
      { id: "qwen3.5-plus", label: "qwen3.5-plus" },
    ],
  },
  {
    id: "cursor-agent",
    name: "Cursor Agent",
    bin: "cursor-agent",
    versionArgs: ["--version"],
    listModels: {
      args: ["models"],
      timeoutMs: 5000,
      parse: (stdout) => {
        if (/no models available/i.test(stdout)) return null;
        return parseLineSeparatedModels(stdout);
      },
    },
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "auto", label: "auto" },
      { id: "sonnet-4", label: "sonnet-4" },
      { id: "gpt-5", label: "gpt-5" },
    ],
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    bin: "copilot",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      { id: "gpt-5.2", label: "GPT-5.2" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek TUI",
    bin: "deepseek",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "deepseek-v4-pro", label: "deepseek-v4-pro" },
      { id: "deepseek-v4-flash", label: "deepseek-v4-flash" },
    ],
  },
];

function parseLineSeparatedModels(stdout: string) {
  const seen = new Set<string>();
  const models: LocalModelOption[] = [DEFAULT_MODEL];
  for (const line of stdout.split("\n")) {
    const id = line.trim();
    if (!id || id.startsWith("#") || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models.length > 1 ? models : null;
}

function parseEnvValue(raw: string) {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function serializeEnvValue(value: string | number | boolean) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function parseEnvText(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    map[match[1]] = parseEnvValue(match[2]);
  }
  return map;
}

function readEnvLocalSync(): Record<string, string> {
  try {
    return parseEnvText(readFileSync(MODEL_ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function readEnvLocal(): Promise<Record<string, string>> {
  try {
    return parseEnvText(await readFile(MODEL_ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

function maskSecret(value: string | undefined) {
  if (!value) return undefined;
  if (value.length <= 12) return "••••";
  return `${value.slice(0, 5)}••••${value.slice(-4)}`;
}

function envFlag(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function readMergedModelEnv(): Record<string, string | undefined> {
  loadLocalModelEnv();
  const local = readEnvLocalSync();
  const merged: Record<string, string | undefined> = {};
  for (const key of MODEL_ENV_KEYS) {
    merged[key] = process.env[key] ?? local[key];
  }
  return merged;
}

export function loadLocalModelEnv() {
  const local = readEnvLocalSync();
  for (const [key, value] of Object.entries(local)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function getModelRuntimeConfig(): ModelRuntimeConfig {
  const env = readMergedModelEnv();
  const apiKey = env.DESIGN_VAULT_MODEL_API_KEY;
  const baseUrl = env.DESIGN_VAULT_MODEL_BASE_URL ?? "";
  const model = env.DESIGN_VAULT_MODEL_NAME ?? "gpt-4.1";
  const timeoutMs = Number(env.DESIGN_VAULT_MODEL_TIMEOUT_MS ?? 120000);
  const mode = normalizeExecutionMode(env.DESIGN_VAULT_EXECUTION_MODE);
  const cliAgentRaw = env.DESIGN_VAULT_CLI_AGENT;
  const cliModel = env.DESIGN_VAULT_CLI_MODEL ?? "";
  const localCli: LocalCliSelection | null = isSupportedAgentId(cliAgentRaw)
    ? { agentId: cliAgentRaw, model: cliModel.trim() || "default" }
    : null;

  const byokConfigured = Boolean(baseUrl && apiKey);
  const localCliConfigured = Boolean(localCli);
  const configured = mode === "local-cli" ? localCliConfigured : byokConfigured;

  return {
    configured,
    mode,
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 120000,
    requireModel: envFlag(env.DESIGN_VAULT_REQUIRE_MODEL),
    apiKeyConfigured: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKeySource: apiKey ? "DESIGN_VAULT_MODEL_API_KEY" : undefined,
    envLocalPath: MODEL_ENV_PATH,
    localCli,
  };
}

function existingDirsUnder(root: string, segments: string[] = []) {
  const dirs: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name, ...segments);
    if (existsSync(full)) dirs.push(full);
  }
  return dirs;
}

function resolvePathDirs() {
  const home = homedir();
  const seen = new Set<string>();
  const dirs = [
    ...(process.env.PATH || "").split(delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...existingDirsUnder(path.join(home, ".nvm", "versions", "node"), ["bin"]),
    ...existingDirsUnder(path.join(home, ".local", "share", "mise", "installs", "node"), ["bin"]),
    ...existingDirsUnder(path.join(home, ".local", "share", "fnm", "node-versions"), ["installation", "bin"]),
  ];

  return dirs.filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

function resolveOnPath(bin: string, pathDirs = resolvePathDirs()) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const full = path.join(dir, `${bin}${ext}`);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

async function detectAgent(def: AgentDef, pathDirs: string[]): Promise<DetectedAgent> {
  const resolved = resolveOnPath(def.bin, pathDirs);
  if (!resolved) {
    return {
      id: def.id,
      name: def.name,
      bin: def.bin,
      available: false,
      models: def.fallbackModels,
    };
  }

  let version: string | undefined;
  try {
    const { stdout, stderr } = await execFileP(resolved, def.versionArgs, { timeout: 3000, maxBuffer: 1024 * 1024 });
    version = (stdout || stderr).trim().split("\n")[0];
  } catch {
    version = undefined;
  }

  let models = def.fallbackModels;
  if (def.listModels) {
    try {
      const { stdout } = await execFileP(resolved, def.listModels.args, {
        timeout: def.listModels.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      models = def.listModels.parse(stdout) ?? def.fallbackModels;
    } catch {
      models = def.fallbackModels;
    }
  }

  return {
    id: def.id,
    name: def.name,
    bin: def.bin,
    available: true,
    path: resolved,
    version,
    models,
  };
}

type CliEndpointMap = {
  baseUrl: string;
  defaultModel: string;
  keyEnvName: string;
  description: (cliName: string, keyAvailable: boolean) => string;
};

// Map each detected CLI to a known OpenAI-compatible endpoint so we can render
// one-click switcher cards. Anthropic-native APIs (Claude Code) aren't usable
// through Design Vault's OpenAI-compat fetcher, so we route them through
// OpenRouter when available — that way the user can still pick "Claude Code"
// and actually have it work.
const CLI_TO_ENDPOINT: Record<string, CliEndpointMap | undefined> = {
  claude: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.5",
    keyEnvName: "OPENROUTER_API_KEY",
    description: (_name, keyAvailable) =>
      keyAvailable
        ? "Design Vault 通过 OpenRouter 转接 Claude 系模型（OPENROUTER_API_KEY 已就绪）。"
        : "Design Vault 通过 OpenRouter 转接 Claude 系模型，需要先在环境里准备 OPENROUTER_API_KEY。",
  },
  codex: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    keyEnvName: "OPENAI_API_KEY",
    description: (_name, keyAvailable) =>
      keyAvailable
        ? "使用 Codex 同源的 OpenAI Chat Completions 接口（OPENAI_API_KEY 已就绪）。"
        : "走 OpenAI 官方 Chat Completions 接口，需要 OPENAI_API_KEY。",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-pro",
    keyEnvName: "GEMINI_API_KEY",
    description: (_name, keyAvailable) =>
      keyAvailable
        ? "走 Gemini 的 OpenAI-compatible 端点（GEMINI_API_KEY 已就绪）。"
        : "走 Gemini 的 OpenAI-compatible 端点，需要 GEMINI_API_KEY。",
  },
  kimi: {
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.5",
    keyEnvName: "MOONSHOT_API_KEY",
    description: (_name, keyAvailable) =>
      keyAvailable
        ? "直接走 Moonshot / Kimi 的 OpenAI-compatible 端点（MOONSHOT_API_KEY 已就绪）。"
        : "直接走 Moonshot / Kimi 的 OpenAI-compatible 端点，需要 MOONSHOT_API_KEY。",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.6-plus",
    keyEnvName: "DASHSCOPE_API_KEY",
    description: (_name, keyAvailable) =>
      keyAvailable
        ? "走阿里云 DashScope 的 OpenAI-compatible 模式（DASHSCOPE_API_KEY 已就绪）。"
        : "走阿里云 DashScope 的 OpenAI-compatible 模式，需要 DASHSCOPE_API_KEY。",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-pro",
    keyEnvName: "DEEPSEEK_API_KEY",
    description: (_name, keyAvailable) =>
      keyAvailable
        ? "走 DeepSeek 官方 OpenAI-compatible 端点（DEEPSEEK_API_KEY 已就绪）。"
        : "走 DeepSeek 官方 OpenAI-compatible 端点，需要 DEEPSEEK_API_KEY。",
  },
};

function preferredCliModel(agent: DetectedAgent, fallback: string) {
  const real = agent.models.find((model) => model.id && model.id !== "default");
  return real?.id ?? fallback;
}

function buildEndpointCandidates(config: ModelRuntimeConfig, agents: DetectedAgent[]) {
  const candidates: EndpointCandidate[] = [];
  const push = (candidate: EndpointCandidate) => {
    const duplicate = candidates.some((item) => item.baseUrl === candidate.baseUrl && item.model === candidate.model && item.label === candidate.label);
    if (!duplicate) candidates.push(candidate);
  };

  if (config.baseUrl || config.model || config.apiKeyConfigured) {
    push({
      id: "current",
      label: "当前 Design Vault 配置",
      description: "来自当前进程或 .env.local，保存后新导入会直接使用这组配置。",
      baseUrl: config.baseUrl,
      model: config.model,
      source: "current",
      keyEnvName: "DESIGN_VAULT_MODEL_API_KEY",
      keyAvailable: config.apiKeyConfigured,
    });
  }

  // One card per locally detected CLI — let the user pick by CLI name and we
  // map to a sensible OpenAI-compatible endpoint behind the scenes.
  for (const agent of agents) {
    if (!agent.available) continue;
    const mapping = CLI_TO_ENDPOINT[agent.id];
    if (!mapping) continue;
    const keyAvailable =
      mapping.keyEnvName === "DESIGN_VAULT_MODEL_API_KEY"
        ? config.apiKeyConfigured
        : Boolean(process.env[mapping.keyEnvName]);
    push({
      id: `cli-${agent.id}`,
      label: agent.name,
      description: mapping.description(agent.name, keyAvailable),
      baseUrl: mapping.baseUrl,
      model: preferredCliModel(agent, mapping.defaultModel),
      source: "local-cli",
      keyEnvName: mapping.keyEnvName,
      keyAvailable,
    });
  }

  const envCandidates: Array<{ id: string; label: string; baseUrl?: string; model?: string; keyEnvName: string; description: string }> = [
    {
      id: "openai-env",
      label: "OpenAI-compatible env",
      baseUrl: process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE,
      model: process.env.OPENAI_MODEL || process.env.MODEL_NAME || "gpt-5.4",
      keyEnvName: "OPENAI_API_KEY",
      description: "从本地 OPENAI_* 环境变量读取，适合任何 OpenAI-compatible 服务。",
    },
    {
      id: "openrouter-env",
      label: "OpenRouter env",
      baseUrl: "https://openrouter.ai/api/v1",
      model: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5",
      keyEnvName: "OPENROUTER_API_KEY",
      description: "检测到 OpenRouter key 时可一键转为 Design Vault 模型后端。",
    },
    {
      id: "moonshot-env",
      label: "Moonshot / Kimi env",
      baseUrl: "https://api.moonshot.cn/v1",
      model: process.env.MOONSHOT_MODEL || "kimi-k2.5",
      keyEnvName: "MOONSHOT_API_KEY",
      description: "从本地 Moonshot/Kimi 环境变量读取，适合直连月之暗面兼容接口。",
    },
    {
      id: "dashscope-env",
      label: "DashScope env",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: process.env.DASHSCOPE_MODEL || "qwen3.6-plus",
      keyEnvName: "DASHSCOPE_API_KEY",
      description: "从本地 DashScope 环境变量读取，使用阿里云 OpenAI-compatible 模式。",
    },
  ];

  for (const candidate of envCandidates) {
    const keyAvailable = Boolean(process.env[candidate.keyEnvName]);
    if (!keyAvailable && !candidate.baseUrl) continue;
    push({
      id: candidate.id,
      label: candidate.label,
      description: candidate.description,
      baseUrl: candidate.baseUrl || "",
      model: candidate.model || "",
      source: "environment",
      keyEnvName: candidate.keyEnvName,
      keyAvailable,
    });
  }

  return candidates;
}

export async function scanModelRuntime(): Promise<ModelRuntimeScan> {
  loadLocalModelEnv();
  const pathDirs = resolvePathDirs();
  const agents = await Promise.all(AGENT_DEFS.map((def) => detectAgent(def, pathDirs)));
  const config = getModelRuntimeConfig();
  return {
    config,
    agents,
    endpointCandidates: buildEndpointCandidates(config, agents),
    pathDirs,
  };
}

async function writeEnvLocal(updates: Partial<Record<ModelEnvKey, string | number | boolean | null>>) {
  let current = "";
  try {
    current = await readFile(MODEL_ENV_PATH, "utf8");
  } catch {
    current = "";
  }

  const pending = new Map<string, string | number | boolean | null>(Object.entries(updates));
  const lines = current ? current.split(/\r?\n/) : [];
  const nextLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match || !pending.has(match[2])) {
      nextLines.push(line);
      continue;
    }

    const value = pending.get(match[2]);
    pending.delete(match[2]);
    if (value === null || value === undefined) continue;
    nextLines.push(`${match[1]}${match[2]}${match[3]}${serializeEnvValue(value)}`);
  }

  for (const [key, value] of pending) {
    if (value === null || value === undefined) continue;
    nextLines.push(`${key}=${serializeEnvValue(value)}`);
  }

  await writeFile(MODEL_ENV_PATH, `${nextLines.filter((line, index, arr) => line.trim() || index < arr.length - 1).join("\n")}\n`, "utf8");
  await chmod(MODEL_ENV_PATH, 0o600).catch(() => {});
}

function normalizeBaseUrl(input: string) {
  const value = input.trim().replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Base URL must start with http:// or https://.");
  return parsed.toString().replace(/\/$/, "");
}

export async function saveModelRuntimeConfig(input: SaveModelConfigInput) {
  const local = await readEnvLocal();
  const current = getModelRuntimeConfig();
  const mode: ExecutionMode = input.mode && EXECUTION_MODES.includes(input.mode) ? input.mode : current.mode;
  const timeoutMsRaw = Number(input.timeoutMs ?? current.timeoutMs ?? 120000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(5000, timeoutMsRaw) : 120000;
  const requireModelFlag = input.requireModel ?? current.requireModel;

  const updates: Partial<Record<ModelEnvKey, string | number | boolean | null>> = {
    DESIGN_VAULT_EXECUTION_MODE: mode,
    DESIGN_VAULT_MODEL_TIMEOUT_MS: timeoutMs,
    DESIGN_VAULT_REQUIRE_MODEL: requireModelFlag ? 1 : 0,
  };

  if (mode === "local-cli") {
    const agentId = (input.cliAgent ?? current.localCli?.agentId ?? "").trim();
    if (!isSupportedAgentId(agentId)) {
      throw new Error(`Local CLI agent is required. Supported: ${SUPPORTED_AGENT_IDS.join(", ")}.`);
    }
    const cliModel = (input.cliModel ?? current.localCli?.model ?? "default").trim() || "default";
    updates.DESIGN_VAULT_CLI_AGENT = agentId;
    updates.DESIGN_VAULT_CLI_MODEL = cliModel;
  } else {
    const baseUrlInput = input.baseUrl ?? current.baseUrl;
    if (!baseUrlInput) throw new Error("Base URL is required for BYOK mode.");
    const baseUrl = normalizeBaseUrl(baseUrlInput);
    const model = (input.model ?? current.model ?? "").trim();
    if (!model) throw new Error("Model is required for BYOK mode.");

    let apiKey: string | null | undefined = undefined;
    if (input.clearApiKey) {
      apiKey = null;
    } else if (input.apiKey?.trim()) {
      apiKey = input.apiKey.trim();
    } else if (input.apiKeyEnvName && ALLOWED_SECRET_ENV_NAMES.has(input.apiKeyEnvName)) {
      const fromEnv = process.env[input.apiKeyEnvName] || local[input.apiKeyEnvName];
      if (fromEnv) apiKey = fromEnv;
    }

    updates.DESIGN_VAULT_MODEL_BASE_URL = baseUrl;
    updates.DESIGN_VAULT_MODEL_NAME = model;
    if (apiKey !== undefined) updates.DESIGN_VAULT_MODEL_API_KEY = apiKey;
  }

  await writeEnvLocal(updates);

  // Sync into current process.env so the running server picks up the change without restart.
  process.env.DESIGN_VAULT_EXECUTION_MODE = mode;
  process.env.DESIGN_VAULT_MODEL_TIMEOUT_MS = String(timeoutMs);
  process.env.DESIGN_VAULT_REQUIRE_MODEL = requireModelFlag ? "1" : "0";

  if (mode === "local-cli") {
    process.env.DESIGN_VAULT_CLI_AGENT = String(updates.DESIGN_VAULT_CLI_AGENT);
    process.env.DESIGN_VAULT_CLI_MODEL = String(updates.DESIGN_VAULT_CLI_MODEL);
  } else {
    process.env.DESIGN_VAULT_MODEL_BASE_URL = String(updates.DESIGN_VAULT_MODEL_BASE_URL);
    process.env.DESIGN_VAULT_MODEL_NAME = String(updates.DESIGN_VAULT_MODEL_NAME);
    const apiKey = updates.DESIGN_VAULT_MODEL_API_KEY;
    if (apiKey === null) {
      delete process.env.DESIGN_VAULT_MODEL_API_KEY;
    } else if (typeof apiKey === "string") {
      process.env.DESIGN_VAULT_MODEL_API_KEY = apiKey;
    }
  }

  return getModelRuntimeConfig();
}

function stripJsonFences(input: string) {
  return input.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

// Carve a JSON object out of an opencode/codex tail that includes a stop
// sentinel ("…}stop"), trailing whitespace, or stray prose. We track brace
// + string state so {"ok":true,"key":"}with-brace"} still parses correctly.
function extractFirstJsonObject(input: string): string | null {
  const text = input.trim();
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseLooseJsonObject<T>(input: string): T | null {
  const stripped = stripJsonFences(input);
  try {
    return JSON.parse(stripped) as T;
  } catch {
    /* fall through to fence-walking */
  }
  const carved = extractFirstJsonObject(stripped);
  if (!carved) return null;
  try {
    return JSON.parse(carved) as T;
  } catch {
    return null;
  }
}

export async function testModelRuntimeConfig(input?: Partial<SaveModelConfigInput>) {
  const current = getModelRuntimeConfig();
  const mode: ExecutionMode = input?.mode && EXECUTION_MODES.includes(input.mode) ? input.mode : current.mode;
  if (mode === "local-cli") {
    return runLocalCliTest(input, current);
  }

  const local = await readEnvLocal();
  const baseUrl = normalizeBaseUrl(input?.baseUrl || current.baseUrl);
  const model = (input?.model || current.model || "gpt-4.1").trim();
  const timeoutMs = Number(input?.timeoutMs ?? current.timeoutMs ?? 120000);
  const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(5000, timeoutMs) : 120000;
  const apiKey =
    input?.apiKey?.trim() ||
    (input?.apiKeyEnvName && ALLOWED_SECRET_ENV_NAMES.has(input.apiKeyEnvName) ? process.env[input.apiKeyEnvName] || local[input.apiKeyEnvName] : undefined) ||
    process.env.DESIGN_VAULT_MODEL_API_KEY ||
    local.DESIGN_VAULT_MODEL_API_KEY;

  if (!apiKey) throw new Error("API key is not configured.");

  const startedAt = Date.now();
  const endpoint = chatCompletionsUrl(baseUrl);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: modelRequestHeaders(apiKey),
      body: JSON.stringify({
        model,
        ...modelTemperatureControl(model, 0),
        ...modelGenerationControls(model, 256, baseUrl),
        ...modelJsonResponseControl(model),
        messages: [
          { role: "system", content: "Return valid JSON only." },
          { role: "user", content: 'Return exactly {"ok":true,"mode":"design-vault-test"}.' },
        ],
      }),
      signal: AbortSignal.timeout(boundedTimeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      model,
      baseUrl,
      durationMs: Date.now() - startedAt,
      message: describeModelFetchFailure(error, endpoint, 1, "Model connection test failed", boundedTimeoutMs),
    };
  }

  const raw = await response.text();
  let message = raw.slice(0, 500);
  let finishReason: string | undefined;
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string };
      choices?: Array<{
        finish_reason?: string;
        native_finish_reason?: string;
        message?: { content?: string | null };
      }>;
    };
    const choice = parsed.choices?.[0];
    const content = choice?.message?.content?.trim();
    finishReason = choice?.finish_reason || choice?.native_finish_reason;

    if (!response.ok) {
      message = parsed.error?.message || content || message;
    } else if (!content) {
      message = [
        "HTTP returned, but the model produced no assistant JSON content.",
        finishReason ? `finish_reason=${finishReason}.` : undefined,
        "This usually means the endpoint spent tokens on hidden reasoning or truncated before content.",
      ]
        .filter(Boolean)
        .join(" ");
    } else if (finishReason === "length") {
      message = `Model output was truncated before a complete usable response. finish_reason=${finishReason}.`;
    } else {
      try {
        const parsedContent = JSON.parse(stripJsonFences(content)) as { ok?: unknown; mode?: unknown };
        if (parsedContent.ok === true && parsedContent.mode === "design-vault-test") {
          message = content;
        } else {
          message = `Model returned JSON, but not the expected test payload: ${content.slice(0, 500)}`;
        }
      } catch {
        message = `Model returned content, but it was not parseable JSON: ${content.slice(0, 500)}`;
      }
    }
  } catch {
    // Keep the raw text summary.
  }

  let usableJson = false;
  try {
    const parsed = JSON.parse(raw) as {
      choices?: Array<{
        finish_reason?: string;
        native_finish_reason?: string;
        message?: { content?: string | null };
      }>;
    };
    const choice = parsed.choices?.[0];
    const content = choice?.message?.content?.trim();
    const reason = choice?.finish_reason || choice?.native_finish_reason;
    if (content && reason !== "length") {
      const parsedContent = JSON.parse(stripJsonFences(content)) as { ok?: unknown; mode?: unknown };
      usableJson = parsedContent.ok === true && parsedContent.mode === "design-vault-test";
    }
  } catch {
    usableJson = false;
  }

  return {
    ok: response.ok && usableJson,
    mode: "byok" as const,
    status: response.status,
    model,
    baseUrl,
    durationMs: Date.now() - startedAt,
    finishReason,
    message,
  };
}

async function runLocalCliTest(
  input: Partial<SaveModelConfigInput> | undefined,
  current: ModelRuntimeConfig,
) {
  const agentIdRaw = (input?.cliAgent ?? current.localCli?.agentId ?? "").trim();
  if (!isSupportedAgentId(agentIdRaw)) {
    throw new Error(`Local CLI agent is required for test. Supported: ${SUPPORTED_AGENT_IDS.join(", ")}.`);
  }
  const cliModel = (input?.cliModel ?? current.localCli?.model ?? "default").trim() || "default";
  const timeoutMs = Number(input?.timeoutMs ?? current.timeoutMs ?? 120000);
  const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(5000, timeoutMs) : 120000;
  const startedAt = Date.now();

  try {
    const result = await runCliCompletion({
      agentId: agentIdRaw,
      model: cliModel,
      timeoutMs: boundedTimeoutMs,
      jsonOutput: true,
      failureLabel: "Local CLI connection test failed",
      messages: [
        { role: "system", content: "Return valid JSON only." },
        { role: "user", content: 'Return exactly {"ok":true,"mode":"design-vault-test"}.' },
      ],
    });
    const stripped = stripJsonFences(result.content);
    let usable = false;
    let message = result.content.slice(0, 500);
    // CLIs sometimes append a stop-reason sentinel (e.g. opencode's "stop")
    // after the assistant JSON. parseLooseJsonObject first tries strict
    // JSON.parse, then carves the first balanced {…} block from the
    // stripped text so suffix noise doesn't poison the test.
    const parsed = parseLooseJsonObject<{ ok?: unknown; mode?: unknown }>(stripped);
    if (parsed) {
      usable = parsed.ok === true && parsed.mode === "design-vault-test";
      message = usable
        ? JSON.stringify(parsed)
        : `CLI returned JSON, but not the expected test payload: ${stripped.slice(0, 500)}`;
    } else {
      message = `CLI returned content, but it was not parseable JSON: ${stripped.slice(0, 500)}`;
    }
    return {
      ok: usable,
      mode: "local-cli" as const,
      status: 200,
      model: result.model,
      agentId: result.agentId,
      durationMs: result.durationMs,
      message,
    };
  } catch (error) {
    return {
      ok: false,
      mode: "local-cli" as const,
      model: cliModel,
      agentId: agentIdRaw,
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
