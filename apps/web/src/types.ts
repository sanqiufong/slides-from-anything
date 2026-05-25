import type {
  AgentInfo,
  AgentModelPrefs,
  AppVersionInfo,
  AppVersionResponse,
  AppUpdateCheckResponse,
  AudioKind,
  ChatAttachment,
  ChatCommentAttachment,
  ChatSlideFeedbackAttachment,
  ChatVaultContextAttachment,
  ChatMessage,
  Conversation,
  DeployConfigResponse,
  DeployProjectFileResponse,
  DesignSystemDetail,
  DesignSystemSummary,
  LiveArtifact,
  LiveArtifactDetailResponse,
  LiveArtifactListResponse,
  LiveArtifactPreview,
  LiveArtifactRefreshLogEntry,
  LiveArtifactRefreshStatus,
  LiveArtifactStatus,
  LiveArtifactSummary,
  MediaAspect,
  ProjectDeploymentsResponse,
  PersistedAgentEvent,
  Project,
  PreviewComment,
  PreviewCommentStatus,
  PreviewCommentTarget,
  PreviewCommentUpsertRequest,
  ProjectDisplayStatus,
  ProjectFile,
  ProjectFileKind,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  SkillDetail,
  SkillSummary,
  SlideFeedback,
  SlideFeedbackStatus,
  UpdateDeployConfigRequest,
  VaultDeleteResponse,
  VaultDesignMeta,
  VaultIngestionJob,
  VaultSyncResponse,
} from '@open-design/contracts';

export type ExecMode = 'daemon' | 'api';
export type ApiProtocol = 'anthropic' | 'openai' | 'azure' | 'google';

export type LiveArtifactTabId = `live:${string}`;
export type ProjectWorkspaceTabId = string | LiveArtifactTabId;

export function liveArtifactTabId(artifactId: string): LiveArtifactTabId {
  return `live:${artifactId}`;
}

export function isLiveArtifactTabId(tabId: string): tabId is LiveArtifactTabId {
  return tabId.startsWith('live:') && tabId.length > 'live:'.length;
}

export function liveArtifactIdFromTabId(tabId: LiveArtifactTabId): string {
  return tabId.slice('live:'.length);
}

export type LiveArtifactViewerTab =
  | 'preview'
  | 'code'
  | 'data'
  | 'refresh-history';

export interface ProjectFileWorkspaceEntry {
  kind: 'file';
  tabId: string;
  name: string;
  file: ProjectFile;
}

export interface LiveArtifactWorkspaceEntry {
  kind: 'live-artifact';
  tabId: LiveArtifactTabId;
  artifactId: string;
  projectId: string;
  title: string;
  slug: string;
  status: LiveArtifactStatus;
  refreshStatus: LiveArtifactRefreshStatus;
  pinned: boolean;
  preview: LiveArtifactPreview;
  hasDocument: boolean;
  updatedAt: string;
  lastRefreshedAt?: string;
}

export type ProjectWorkspaceEntry = ProjectFileWorkspaceEntry | LiveArtifactWorkspaceEntry;

export function liveArtifactSummaryToWorkspaceEntry(
  liveArtifact: LiveArtifactSummary,
): LiveArtifactWorkspaceEntry {
  const entry: LiveArtifactWorkspaceEntry = {
    kind: 'live-artifact',
    tabId: liveArtifactTabId(liveArtifact.id),
    artifactId: liveArtifact.id,
    projectId: liveArtifact.projectId,
    title: liveArtifact.title,
    slug: liveArtifact.slug,
    status: liveArtifact.status,
    refreshStatus: liveArtifact.refreshStatus,
    pinned: liveArtifact.pinned,
    preview: liveArtifact.preview,
    hasDocument: liveArtifact.hasDocument,
    updatedAt: liveArtifact.updatedAt,
  };
  if (liveArtifact.lastRefreshedAt) entry.lastRefreshedAt = liveArtifact.lastRefreshedAt;
  return entry;
}

export interface LiveArtifactPreviewRequest {
  projectId: string;
  artifactId: string;
  previewUrl: string;
}

export interface MediaProviderCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface CodexImageProxyStatus {
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
}

export interface ApiProtocolConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiVersion?: string;
  apiProviderBaseUrl?: string | null;
}

// Per-CLI model + reasoning the user picked in the model menu. Each agent
// keeps its own slot so flipping between Codex and Gemini doesn't reset the
// other one's choice. Missing entries fall back to the agent's first
// declared model (`'default'` — let the CLI pick).
export type AgentModelChoice = AgentModelPrefs;

export type AppTheme = 'system' | 'light' | 'dark';

export interface NotificationsConfig {
  // Master switch for the completion sound. Default false — first-run users
  // hear nothing until they opt in.
  soundEnabled: boolean;
  // Sound id played when a turn ends with `runStatus === 'succeeded'`.
  successSoundId: string;
  // Sound id played when a turn ends with `runStatus === 'failed'`.
  failureSoundId: string;
  // Master switch for the browser Notification API banner. Default false.
  desktopEnabled: boolean;
}

export interface AppConfig {
  mode: ExecMode;
  apiKey: string;
  baseUrl: string;
  model: string;
  apiProtocol?: ApiProtocol;
  apiVersion?: string;
  apiProtocolConfigs?: Partial<Record<ApiProtocol, ApiProtocolConfig>>;
  /** Internal config schema/migration version for localStorage upgrades. */
  configMigrationVersion?: number;
  /** Base URL of the selected known provider; cleared once the user customizes provider fields. */
  apiProviderBaseUrl?: string | null;
  agentId: string | null;
  skillId: string | null;
  designSystemId: string | null;
  theme?: AppTheme;
  // True once the user has been through the welcome onboarding modal at
  // least once (saved or skipped). Bootstrap skips the auto-popup when
  // this is set so refreshing the page doesn't re-prompt.
  onboardingCompleted?: boolean;
  mediaProviders?: Record<string, MediaProviderCredentials>;
  composio?: ComposioSettings;
  // Per-CLI model picker state, keyed by agent id (e.g. `gemini`, `codex`).
  // Pre-existing configs without this field fall through to the agent's
  // declared default.
  agentModels?: Record<string, AgentModelChoice>;
  // Caps the upstream completion length in API mode. Defaults to 8192 when
  // unset; raise it for providers (e.g. MiMo) that allow longer responses.
  maxTokens?: number;
  // Optional task-completion sound + browser notification settings. Older
  // configs that pre-date the feature land at `undefined`, which the loader
  // normalizes to a safe default (everything off).
  notifications?: NotificationsConfig;
}

export interface ComposioSettings {
  apiKey?: string;
  apiKeyConfigured?: boolean;
  apiKeyTail?: string;
}

export type AgentEvent = PersistedAgentEvent;

export interface LiveArtifactEventItem {
  id: number;
  event: Extract<AgentEvent, { kind: 'live_artifact' | 'live_artifact_refresh' }>;
}

export type { ChatAttachment, ChatCommentAttachment, ChatMessage };

export interface Artifact {
  identifier: string;
  artifactType?: string;
  title: string;
  html: string;
  savedUrl?: string;
}

export interface ExamplePreview {
  source: 'skill' | 'design-system';
  id: string;
  title: string;
  html: string;
}

export interface AgentModelOption {
  id: string;
  label: string;
}

export type Surface = 'web' | 'image' | 'video' | 'audio';

export interface PromptTemplateSource {
  repo: string;
  license: string;
  author?: string;
  url?: string;
}

export interface PromptTemplateSummary {
  id: string;
  surface: 'image' | 'video';
  title: string;
  summary: string;
  category: string;
  tags?: string[];
  model?: string;
  aspect?: MediaAspect;
  previewImageUrl?: string;
  previewVideoUrl?: string;
  source: PromptTemplateSource;
}

export interface PromptTemplateDetail extends PromptTemplateSummary {
  prompt: string;
}

export type {
  AgentInfo,
  AppUpdateCheckResponse,
  AppVersionInfo,
  AppVersionResponse,
  AudioKind,
  ChatSlideFeedbackAttachment,
  ChatVaultContextAttachment,
  Conversation,
  DeployConfigResponse,
  DeployProjectFileResponse,
  DesignSystemDetail,
  DesignSystemSummary,
  LiveArtifact,
  LiveArtifactDetailResponse,
  LiveArtifactListResponse,
  LiveArtifactRefreshLogEntry,
  LiveArtifactRefreshStatus,
  LiveArtifactStatus,
  LiveArtifactSummary,
  MediaAspect,
  ProjectDeploymentsResponse,
  Project,
  PreviewComment,
  PreviewCommentStatus,
  PreviewCommentTarget,
  PreviewCommentUpsertRequest,
  ProjectDisplayStatus,
  ProjectFile,
  ProjectFileKind,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  SkillDetail,
  SkillSummary,
  SlideFeedback,
  SlideFeedbackStatus,
  UpdateDeployConfigRequest,
  VaultDeleteResponse,
  VaultDesignMeta,
  VaultIngestionJob,
  VaultSyncResponse,
};

export interface OpenTabsState {
  tabs: ProjectWorkspaceTabId[];
  active: ProjectWorkspaceTabId | null;
}
