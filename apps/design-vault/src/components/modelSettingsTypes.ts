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

export type ExecutionMode = "local-cli" | "byok";

export type LocalCliSelection = {
  agentId: string;
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

export type TestResult = {
  ok?: boolean;
  mode?: ExecutionMode;
  status?: number;
  model?: string;
  baseUrl?: string;
  agentId?: string;
  durationMs?: number;
  finishReason?: string;
  message?: string;
  error?: string;
};

export type ScanRefreshHandler = () => Promise<void>;
