import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHtmlArtifactManifest, inferLegacyManifest } from '../artifacts/manifest';
import { createArtifactParser } from '../artifacts/parser';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { streamMessage } from '../providers/anthropic';
import {
  fetchChatRunStatus,
  listActiveChatRuns,
  reattachDaemonRun,
  streamViaDaemon,
} from '../providers/daemon';
import {
  deletePreviewComment,
  fetchPreviewComments,
  fetchDesignSystem,
  fetchLiveArtifacts,
  fetchCodexImageProxyStatus,
  fetchMediaProviderConfigStatus,
  fetchProjectFiles,
  fetchSkill,
  fetchSlideFeedback,
  lockOpenPptVaultTemplate,
  patchPreviewCommentStatus,
  patchSlideFeedbackStatus,
  upsertPreviewComment,
  writeProjectTextFile,
  type MediaProviderConfigStatus,
} from '../providers/registry';
import { useProjectFileEvents, type ProjectEvent } from '../providers/project-events';
import { composeSystemPrompt } from '@open-design/contracts';
import { navigate } from '../router';
import { IMAGE_MODELS, findProvider, type MediaProviderId } from '../media/models';
import { agentDisplayName, agentModelDisplayName } from '../utils/agentLabels';
import {
  apiProtocolAgentId,
  apiProtocolModelLabel,
} from '../utils/apiProtocol';
import { playSound, showCompletionNotification } from '../utils/notifications';
import { DEFAULT_NOTIFICATIONS } from '../state/config';
import type { TodoItem } from '../runtime/todos';
import { isLiveArtifactTabId, liveArtifactTabId } from '../types';
import {
  createConversation,
  deleteConversation as deleteConversationApi,
  getTemplate,
  listConversations,
  listMessages,
  loadTabs,
  patchConversation,
  patchProject,
  saveMessage,
  saveTabs,
} from '../state/projects';
import type {
  AgentEvent,
  AgentInfo,
  AppConfig,
  Artifact,
  ChatAttachment,
  ChatCommentAttachment,
  ChatSlideFeedbackAttachment,
  ChatVaultContextAttachment,
  ChatMessage,
  Conversation,
  CodexImageProxyStatus,
  DesignSystemSummary,
  OpenTabsState,
  Project,
  ProjectMetadata,
  PreviewComment,
  PreviewCommentTarget,
  ProjectFile,
  ProjectTemplate,
  LiveArtifactEventItem,
  LiveArtifactSummary,
  MediaAspect,
  SkillSummary,
  SlideFeedback,
  VaultDesignMeta,
} from '../types';
import {
  commentsToAttachments,
  historyWithCommentAttachmentContext,
  mergeAttachedComments,
  removeAttachedComment,
} from '../comments';
import { AppChromeHeader } from './AppChromeHeader';
import { AvatarMenu } from './AvatarMenu';
import { ChatPane } from './ChatPane';
import { decideAutoOpenAfterWrite } from './auto-open-file';
import { FileWorkspace } from './FileWorkspace';

interface Props {
  project: Project;
  routeFileName: string | null;
  config: AppConfig;
  agents: AgentInfo[];
  skills: SkillSummary[];
  designSystems: DesignSystemSummary[];
  daemonLive: boolean;
  onModeChange: (mode: AppConfig['mode']) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onRefreshAgents: () => void;
  onOpenSettings: () => void;
  onBack: () => void;
  onClearPendingPrompt: () => void;
  onTouchProject: () => void;
  onProjectChange: (next: Project) => void;
  onProjectsRefresh: () => void;
}

let liveArtifactEventSequence = 0;

function appendLiveArtifactEventItem(
  prev: LiveArtifactEventItem[],
  event: LiveArtifactEventItem['event'],
): LiveArtifactEventItem[] {
  liveArtifactEventSequence += 1;
  const next = [...prev, { id: liveArtifactEventSequence, event }];
  return next.length > 50 ? next.slice(next.length - 50) : next;
}

function projectEventToAgentEvent(evt: ProjectEvent): LiveArtifactEventItem['event'] | null {
  if (evt.type === 'file-changed') return null;
  if (evt.type === 'live_artifact') {
    return {
      kind: 'live_artifact',
      action: evt.action,
      projectId: evt.projectId,
      artifactId: evt.artifactId,
      title: evt.title,
      refreshStatus: evt.refreshStatus,
    };
  }
  return {
    kind: 'live_artifact_refresh',
    phase: evt.phase,
    projectId: evt.projectId,
    artifactId: evt.artifactId,
    refreshId: evt.refreshId,
    title: evt.title,
    refreshedSourceCount: evt.refreshedSourceCount,
    error: evt.error,
  };
}

function vaultTemplateSlugFromFormAnswer(text: string): string | null {
  const header = text.split('\n', 1)[0] ?? '';
  if (!/^\[form answers\b/i.test(header) || !/vault-template/i.test(header)) return null;
  return text.match(/\bslug:\s*([a-z0-9][a-z0-9_-]*)/i)?.[1] ?? null;
}

const DECK_MEDIA_INTENT_RE =
  /(?:gpt\s*[-_ ]?\s*image|媒体模型|图片生成|图像生成|生成.{0,16}(?:图片|图像|配图|插图|image)|(?:关键页|关键页面|重点页|封面|重要页面|重要的页面).{0,32}(?:图片|图像|配图|插图|image)|AI\s*(?:图片|配图|插图|image)|svg\s*\/\s*image|image\s*\/\s*svg|SVG\s*\/\s*图片|(?:图片|图像|配图|插图|image).{0,16}(?:辅助|描述|说明|支撑|插入)|视觉辅助)/i;

const DECK_MEDIA_NEGATION_RE =
  /(?:不需要|不用|不要|无需|别|禁止|不生成|不要生成).{0,18}(?:图片|图像|配图|插图|image|媒体模型|生成图)/i;

const DECK_MEDIA_IMAGE_PROVIDER_IDS = new Set<MediaProviderId>(['openai', 'volcengine', 'grok']);

export interface DeckMediaImageEnvironment {
  id: string;
  label: string;
  model: string;
  providerId: MediaProviderId;
}

export type DeckMediaImageModelNotice =
  | { kind: 'missing-provider' }
  | { kind: 'ambiguous-provider'; choices: string };

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

interface MediaProviderConfigLike {
  apiKey?: string;
  baseUrl?: string;
  configured?: boolean;
  source?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeImageModelFromPrompt(text: string): string | null {
  for (const model of IMAGE_MODELS) {
    const exactId = new RegExp(`(^|[^a-z0-9_.-])${escapeRegExp(model.id)}($|[^a-z0-9_.-])`, 'i');
    const exactLabel = model.label !== model.id
      ? new RegExp(`(^|[^a-z0-9_.-])${escapeRegExp(model.label)}($|[^a-z0-9_.-])`, 'i')
      : null;
    if (exactId.test(text) || exactLabel?.test(text)) return model.id;
  }
  const match = text.match(/\bgpt\s*[-_ ]?\s*image\s*[-_ ]?(2|1\.5|1\s*[-_ ]?mini|1)\b/i);
  if (!match) return null;
  const variant = match[1]?.replace(/\s+/g, '').replace(/_/g, '-').toLowerCase();
  if (variant === '1-mini') return 'gpt-image-1-mini';
  if (variant === '1.5') return 'gpt-image-1.5';
  if (variant === '1') return 'gpt-image-1';
  return 'gpt-image-2';
}

function extractDeckMediaAspect(text: string): MediaAspect | null {
  return (text.match(/\b(1:1|16:9|9:16|4:3|3:4)\b/)?.[1] as MediaAspect | undefined) ?? null;
}

function hasDeckMediaIntent(text: string): boolean {
  return DECK_MEDIA_INTENT_RE.test(text) && !DECK_MEDIA_NEGATION_RE.test(text);
}

function mediaProviderConfigIsActive(entry: MediaProviderConfigLike | undefined): boolean {
  return Boolean(
    entry?.configured ||
      entry?.apiKey?.trim() ||
      entry?.baseUrl?.trim(),
  );
}

function isCodexOpenAIOAuth(entry: MediaProviderConfigStatus | undefined): boolean {
  return entry?.source === 'oauth-codex' || entry?.source === 'oauth-hermes';
}

function defaultImageModelForProvider(providerId: MediaProviderId): string | null {
  return (
    IMAGE_MODELS.find((model) => model.provider === providerId && model.default)?.id ??
    IMAGE_MODELS.find((model) => model.provider === providerId)?.id ??
    null
  );
}

export function deckMediaImageEnvironments({
  localProviders,
  daemonProviders,
  codexImageProxyStatus,
}: {
  localProviders?: Record<string, MediaProviderConfigLike>;
  daemonProviders?: Record<string, MediaProviderConfigStatus>;
  codexImageProxyStatus?: CodexImageProxyStatus | null;
}): DeckMediaImageEnvironment[] {
  const environments: DeckMediaImageEnvironment[] = [];
  const codexReady =
    codexImageProxyStatus?.enabled !== false &&
    codexImageProxyStatus?.auth.configured === true &&
    Boolean(codexImageProxyStatus.defaultModel);

  if (codexReady) {
    environments.push({
      id: 'codex-image-proxy',
      label: 'Codex Image Proxy',
      model: codexImageProxyStatus.defaultModel,
      providerId: 'openai',
    });
  }

  for (const providerId of DECK_MEDIA_IMAGE_PROVIDER_IDS) {
    const provider = findProvider(providerId);
    const model = defaultImageModelForProvider(providerId);
    if (!provider || !model) continue;
    if (
      providerId === 'openai' &&
      codexReady &&
      !mediaProviderConfigIsActive(localProviders?.openai) &&
      isCodexOpenAIOAuth(daemonProviders?.openai)
    ) {
      continue;
    }
    if (
      !mediaProviderConfigIsActive(localProviders?.[providerId]) &&
      !mediaProviderConfigIsActive(daemonProviders?.[providerId])
    ) {
      continue;
    }
    environments.push({
      id: providerId,
      label: provider.label,
      model,
      providerId,
    });
  }

  return environments;
}

export function deckMediaImageModelChoice({
  prompt,
  existing,
  environments,
}: {
  prompt: string;
  existing?: ProjectMetadata['deckMedia'];
  environments: DeckMediaImageEnvironment[];
}): { model?: string; notice?: DeckMediaImageModelNotice } {
  const explicitModel = normalizeImageModelFromPrompt(prompt);
  if (explicitModel) return { model: explicitModel };
  if (existing?.imageModel) return { model: existing.imageModel };
  const [onlyEnvironment] = environments;
  if (environments.length === 1 && onlyEnvironment) {
    return { model: onlyEnvironment.model };
  }
  if (environments.length === 0) {
    return {
      notice: { kind: 'missing-provider' },
    };
  }
  const choices = environments
    .map((environment) => `${environment.label}：${environment.model}`)
    .join('、');
  return {
    notice: { kind: 'ambiguous-provider', choices },
  };
}

function deckMediaImageModelNoticeMessage(
  t: TranslateFn,
  notice: DeckMediaImageModelNotice,
): string {
  if (notice.kind === 'ambiguous-provider') {
    return t('chat.notice.deckMediaAmbiguousProvider', { choices: notice.choices });
  }
  return t('chat.notice.deckMediaNoProvider');
}

function extractDeckMediaKeySlidePolicy(text: string): string | null {
  const directAnswer = text.match(
    /(?:SVG\s*\/\s*(?:图片|image)|(?:图片|图像|配图|插图|image).{0,16}(?:辅助|描述|说明|支撑|插入)|视觉辅助)[^\n:：]{0,48}[:：]\s*([^\n]+)/i,
  )?.[1];
  const keyPageAnswer = text.match(
    /(?:关键页|关键页面|重点页|封面|重要页面|重要的页面).{0,36}(?:图片|图像|配图|插图|image)[^\n:：]{0,32}[:：]\s*([^\n]+)/i,
  )?.[1];
  const selected = (directAnswer ?? keyPageAnswer)
    ?.replace(/\(skipped\)/gi, '')
    .replace(/（跳过）/g, '')
    .trim();
  if (!selected) return null;
  return `Generate real image assets for selected visual-aid pages: ${selected}. SVG/vector graphics may support the layout, but they do not replace the required generated image bytes.`;
}

export function resolveDeckMediaIntentPrompt(
  prompt: string,
  previousUserPrompts: string[] = [],
): string {
  const current = prompt.trim();
  if (!current) return current;
  if (DECK_MEDIA_INTENT_RE.test(current) || DECK_MEDIA_NEGATION_RE.test(current)) {
    return current;
  }
  const priorIntent = [...previousUserPrompts]
    .reverse()
    .find((text) => hasDeckMediaIntent(text));
  return priorIntent ?? current;
}

export function deckMediaFromPrompt(
  prompt: string,
  existing?: ProjectMetadata['deckMedia'],
  resolvedImageModel?: string,
): ProjectMetadata['deckMedia'] | null {
  if (!hasDeckMediaIntent(prompt)) {
    return null;
  }
  const model = normalizeImageModelFromPrompt(prompt) ?? existing?.imageModel ?? resolvedImageModel;
  const aspect = extractDeckMediaAspect(prompt) ?? existing?.imageAspect ?? '16:9';
  const keySlidePolicy = extractDeckMediaKeySlidePolicy(prompt);
  return {
    ...existing,
    enabled: true,
    required: true,
    ...(model ? { imageModel: model } : {}),
    imageAspect: aspect,
    source: 'chat',
    keySlidePolicy:
      keySlidePolicy ??
      existing?.keySlidePolicy ??
      'Generate real image assets for key visual pages where the user asked for media-model imagery; use at least one generated image when the request mentions key-page illustrations or generated配图.',
    capturedFrom: prompt.slice(0, 240),
  };
}

export function shouldAutoCollapseChatForOpenSlideInspect({
  inspectActive,
  chatCollapsed,
  userExpandedAfterAutoCollapse,
}: {
  inspectActive: boolean;
  chatCollapsed: boolean;
  userExpandedAfterAutoCollapse: boolean;
}): boolean {
  return inspectActive && !chatCollapsed && !userExpandedAfterAutoCollapse;
}

export function ProjectView({
  project,
  routeFileName,
  config,
  agents,
  skills,
  designSystems,
  daemonLive,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onRefreshAgents,
  onOpenSettings,
  onBack,
  onClearPendingPrompt,
  onTouchProject,
  onProjectChange,
  onProjectsRefresh,
}: Props) {
  const t = useT();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [previewComments, setPreviewComments] = useState<PreviewComment[]>([]);
  const [attachedComments, setAttachedComments] = useState<PreviewComment[]>([]);
  const [slideFeedback, setSlideFeedback] = useState<SlideFeedback[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [openSlideInspectActive, setOpenSlideInspectActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [filesRefresh, setFilesRefresh] = useState(0);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [liveArtifacts, setLiveArtifacts] = useState<LiveArtifactSummary[]>([]);
  const [liveArtifactEvents, setLiveArtifactEvents] = useState<LiveArtifactEventItem[]>([]);
  // The persisted set of open tabs + active tab. Persisted via PUT on every
  // change; loaded once when the project mounts.
  const [openTabsState, setOpenTabsState] = useState<OpenTabsState>({
    tabs: [],
    active: null,
  });
  const tabsLoadedRef = useRef(false);
  // Routed to FileWorkspace — bumped whenever the user clicks "open" on a
  // tool card, an attachment chip, or a produced-file chip in chat. We
  // include a nonce so re-clicking the same name after the user closed the
  // tab still focuses it.
  const [openRequest, setOpenRequest] = useState<{ name: string; nonce: number } | null>(null);
  const autoCollapsedChatForInspectRef = useRef(false);
  const userExpandedChatAfterInspectCollapseRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  const sendTextBufferRef = useRef<BufferedTextUpdates | null>(null);
  const reattachTextBuffersRef = useRef<Set<BufferedTextUpdates>>(new Set());
  const reattachControllersRef = useRef<Map<string, AbortController>>(new Map());
  const reattachCancelControllersRef = useRef<Map<string, AbortController>>(new Map());
  const completedReattachRunsRef = useRef<Set<string>>(new Set());
  const skillCache = useRef<Map<string, string>>(new Map());
  const designCache = useRef<Map<string, string>>(new Map());
  const templateCache = useRef<Map<string, ProjectTemplate>>(new Map());
  // We auto-save the most recent artifact to the project folder. Track the
  // last name we persisted so re-renders during streaming don't spawn
  // duplicate writes.
  const savedArtifactRef = useRef<string | null>(null);
  // Pending Write tool invocations: tool_use_id -> destination basename.
  // When the matching tool_result lands we refresh the file list and open
  // the file as a tab once. Keying off the tool_use_id (rather than
  // diffing the file list at end-of-turn) lets us auto-open the moment
  // the agent's Write actually completes, without the previous synthetic
  // "live" tab that was causing flicker against manual opens.
  const pendingWritesRef = useRef<Map<string, string>>(new Map());

  // Load conversations on project switch. If none exist (older projects
  // pre-conversations, or a freshly created one whose default seed got
  // dropped), create one on the fly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await listConversations(project.id);
      if (cancelled) return;
      if (list.length === 0) {
        const fresh = await createConversation(project.id);
        if (cancelled) return;
        if (fresh) {
          setConversations([fresh]);
          setActiveConversationId(fresh.id);
        } else {
          setConversations([]);
          setActiveConversationId(null);
          setError(
            'This project could not be loaded. It may have been deleted or the daemon is unavailable.',
          );
          void onProjectsRefresh();
        }
      } else {
        setConversations(list);
        setActiveConversationId(list[0]!.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, onProjectsRefresh]);

  // Load messages whenever the active conversation changes. This happens
  // on project mount (after conversations load) and on user-triggered
  // conversation switches.
  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
      setPreviewComments([]);
      setAttachedComments([]);
      setSlideFeedback([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [list, comments, feedback] = await Promise.all([
        listMessages(project.id, activeConversationId),
        fetchPreviewComments(project.id, activeConversationId),
        fetchSlideFeedback(project.id, activeConversationId),
      ]);
      if (cancelled) return;
      setMessages(list);
      setPreviewComments(comments);
      setSlideFeedback(feedback);
      setAttachedComments([]);
      setArtifact(null);
      setError(null);
      setNotice(null);
      savedArtifactRef.current = null;
      pendingWritesRef.current.clear();
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, activeConversationId]);

  useEffect(() => {
    return () => {
      sendTextBufferRef.current?.cancel();
      sendTextBufferRef.current = null;
      for (const textBuffer of reattachTextBuffersRef.current) textBuffer.cancel();
      reattachTextBuffersRef.current.clear();
      for (const controller of reattachControllersRef.current.values()) {
        controller.abort();
      }
      for (const controller of reattachCancelControllersRef.current.values()) {
        controller.abort();
      }
      reattachControllersRef.current.clear();
      reattachCancelControllersRef.current.clear();
    };
  }, [project.id, activeConversationId]);

  const cancelSendTextBuffer = useCallback((flushPending = false) => {
    if (flushPending) sendTextBufferRef.current?.flush();
    sendTextBufferRef.current?.cancel();
    sendTextBufferRef.current = null;
  }, []);

  const cancelReattachTextBuffers = useCallback((flushPending = false) => {
    for (const textBuffer of reattachTextBuffersRef.current) {
      if (flushPending) textBuffer.flush();
      textBuffer.cancel();
    }
    reattachTextBuffersRef.current.clear();
  }, []);

  // Detect the streaming `true → false` edge so we can fire the optional
  // completion sound / desktop notification exactly once per turn. Initial
  // mount keeps `prevStreamingRef.current = false`, so loading historical
  // conversations (where `streaming` is also false) never triggers a stray
  // ding. `messages` is on the dep array so the latest assistant message's
  // runStatus is visible at the moment we edge-detect; the early-return
  // guarantees only the edge actually does anything.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (!(wasStreaming && !streaming)) return;

    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!last) return;
    const status = last.runStatus;
    if (status !== 'succeeded' && status !== 'failed') return;

    const cfg = config.notifications ?? DEFAULT_NOTIFICATIONS;
    if (cfg.soundEnabled) {
      playSound(status === 'succeeded' ? cfg.successSoundId : cfg.failureSoundId);
    }

    if (cfg.desktopEnabled) {
      // Successes only interrupt when the user is on another tab/window.
      // Failures alert regardless — losing a long agent run silently is
      // worse than a small interruption when the page is in focus.
      const isHidden = typeof document !== 'undefined' && document.hidden;
      const isFocused = typeof document === 'undefined' ? true : document.hasFocus();
      if (status === 'failed' || isHidden || !isFocused) {
        const title = status === 'succeeded'
          ? t('notify.successTitle')
          : t('notify.failureTitle');
        const fallbackBody = status === 'succeeded'
          ? t('notify.successBody')
          : t('notify.failureBody');
        const trimmed = (last.content ?? '').trim();
        const body = trimmed ? trimmed.slice(0, 80) : fallbackBody;
        void showCompletionNotification({
          status,
          title,
          body,
          onClick: () => {
            if (typeof window !== 'undefined') window.focus();
          },
        });
      }
    }
  }, [streaming, messages, config.notifications, t]);

  const handleChatCollapsedChange = useCallback((collapsed: boolean) => {
    if (!collapsed && autoCollapsedChatForInspectRef.current) {
      userExpandedChatAfterInspectCollapseRef.current = true;
    }
    setChatCollapsed(collapsed);
  }, []);

  const handleOpenSlideInspectActiveChange = useCallback((active: boolean) => {
    setOpenSlideInspectActive(active);
    if (!active) {
      autoCollapsedChatForInspectRef.current = false;
      userExpandedChatAfterInspectCollapseRef.current = false;
      return;
    }
    if (
      shouldAutoCollapseChatForOpenSlideInspect({
        inspectActive: active,
        chatCollapsed,
        userExpandedAfterAutoCollapse: userExpandedChatAfterInspectCollapseRef.current,
      })
    ) {
      autoCollapsedChatForInspectRef.current = true;
      setChatCollapsed(true);
    }
  }, [chatCollapsed]);

  useEffect(() => {
    if (streaming && !openSlideInspectActive) setChatCollapsed(false);
  }, [streaming, openSlideInspectActive]);

  // Hydrate the open-tabs state once per project. After this initial
  // load, every mutation flows through saveTabsState() which keeps DB +
  // local state coherent.
  useEffect(() => {
    let cancelled = false;
    tabsLoadedRef.current = false;
    (async () => {
      const state = await loadTabs(project.id);
      if (cancelled) return;
      setOpenTabsState(state);
      tabsLoadedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const persistTabsState = useCallback(
    (next: OpenTabsState) => {
      setOpenTabsState(next);
      if (tabsLoadedRef.current) {
        void saveTabs(project.id, next);
      }
    },
    [project.id],
  );

  const refreshProjectFiles = useCallback(async (): Promise<ProjectFile[]> => {
    const next = await fetchProjectFiles(project.id);
    setProjectFiles(next);
    return next;
  }, [project.id]);

  const refreshLiveArtifacts = useCallback(async (): Promise<LiveArtifactSummary[]> => {
    const next = await fetchLiveArtifacts(project.id);
    setLiveArtifacts(next);
    return next;
  }, [project.id]);

  const refreshWorkspaceItems = useCallback(async (): Promise<ProjectFile[]> => {
    const [nextFiles] = await Promise.all([refreshProjectFiles(), refreshLiveArtifacts()]);
    return nextFiles;
  }, [refreshLiveArtifacts, refreshProjectFiles]);

  const requestOpenFile = useCallback((name: string) => {
    if (!name) return;
    setOpenRequest({ name, nonce: Date.now() });
  }, []);

  const lockVaultTemplateFromPrompt = useCallback(
    async (prompt: string): Promise<boolean> => {
      const slug = vaultTemplateSlugFromFormAnswer(prompt);
      if (!slug) return true;
      const result = await lockOpenPptVaultTemplate(project.id, {
        slug,
        slideId: project.metadata?.slideId ?? null,
        applyToCurrentDeck: true,
      });
      if (!result?.project) {
        setError(
          `无法锁定 Design Vault 模板 ${slug}，已停止发送，避免 agent 在未绑定模板的情况下继续生成。`,
        );
        return false;
      }
      onProjectChange(result.project);
      setFilesRefresh((n) => n + 1);
      await refreshProjectFiles();
      return true;
    },
    [onProjectChange, project.id, project.metadata?.slideId, refreshProjectFiles],
  );

  const handleVaultTemplateSelect = useCallback(
    async (design: VaultDesignMeta): Promise<void> => {
      const result = await lockOpenPptVaultTemplate(project.id, {
        slug: design.slug,
        slideId: project.metadata?.slideId ?? null,
        applyToCurrentDeck: true,
      });
      if (!result?.project) {
        setError(`无法加载 Design Vault 模板 ${design.title || design.slug} 到当前 session。`);
        return;
      }
      setError(null);
      onProjectChange(result.project);
      setFilesRefresh((n) => n + 1);
      await refreshProjectFiles();
    },
    [onProjectChange, project.id, project.metadata?.slideId, refreshProjectFiles],
  );

  const persistDeckMediaFromPrompt = useCallback(
    async (prompt: string): Promise<boolean> => {
      if (project.metadata?.kind !== 'deck') return true;
      const draftDeckMedia = deckMediaFromPrompt(prompt, project.metadata.deckMedia);
      if (!draftDeckMedia) return true;
      const explicitOrExistingModel =
        normalizeImageModelFromPrompt(prompt) ?? project.metadata.deckMedia?.imageModel;
      let resolvedImageModel = explicitOrExistingModel ?? undefined;
      let deckMediaNotice: DeckMediaImageModelNotice | undefined;
      if (!resolvedImageModel) {
        const [daemonProviders, codexImageProxyStatus] = await Promise.all([
          fetchMediaProviderConfigStatus(),
          fetchCodexImageProxyStatus(),
        ]);
        const environments = deckMediaImageEnvironments({
          localProviders: config.mediaProviders,
          daemonProviders,
          codexImageProxyStatus,
        });
        const modelChoice = deckMediaImageModelChoice({
          prompt,
          existing: project.metadata.deckMedia,
          environments,
        });
        deckMediaNotice = modelChoice.notice;
        resolvedImageModel = modelChoice.model;
      }
      const deckMedia = deckMediaFromPrompt(
        prompt,
        project.metadata.deckMedia,
        resolvedImageModel,
      );
      if (!deckMedia) return true;
      const metadata: ProjectMetadata = {
        ...project.metadata,
        deckMedia,
      };
      const nextProject = await patchProject(project.id, { metadata });
      if (!nextProject) {
        setError(t('chat.error.deckMediaConfigWriteFailed'));
        return false;
      }
      setNotice(deckMediaNotice ? deckMediaImageModelNoticeMessage(t, deckMediaNotice) : null);
      onProjectChange(nextProject);
      return true;
    },
    [config.mediaProviders, onProjectChange, project.id, project.metadata, t],
  );

  // Set of project file names that the chat surface uses to decide whether
  // a tool card's path is openable as a tab. Recomputed on every file-list
  // change; tool cards just read from the set.
  const projectFileNames = useMemo(
    () => new Set(projectFiles.map((f) => f.name)),
    [projectFiles],
  );
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  // Keep the @-picker's source of truth fresh: every refreshSignal bump
  // (artifact saved, sketch saved, image uploaded) refetches; on first
  // mount we also do an initial pull so attachments staged before the
  // agent has written anything still see the user's pasted images.
  useEffect(() => {
    if (!daemonLive) return;
    void refreshWorkspaceItems();
  }, [daemonLive, refreshWorkspaceItems, filesRefresh]);

  // Live-reload: when the daemon's chokidar watcher reports a file change,
  // bump filesRefresh so the file list refetches with new mtimes — which
  // propagates through to FileViewer iframes via PR #384's ?v=${mtime}
  // cache-bust, triggering an automatic preview reload without a click.
  const handleProjectEvent = useCallback((evt: ProjectEvent) => {
    if (evt.type === 'file-changed') {
      setFilesRefresh((n) => n + 1);
      return;
    }
    const agentEvent = projectEventToAgentEvent(evt);
    if (!agentEvent) return;
    setLiveArtifactEvents((prev) => appendLiveArtifactEventItem(prev, agentEvent));
    void refreshLiveArtifacts();
    onProjectsRefresh();
  }, [onProjectsRefresh, refreshLiveArtifacts]);
  useProjectFileEvents(project.id, daemonLive, handleProjectEvent);

  // When the URL points at a specific file, fire an open request so the
  // FileWorkspace promotes it to an active tab. We watch routeFileName
  // (the parsed segment) so back/forward navigation triggers the same path.
  useEffect(() => {
    if (!routeFileName) return;
    requestOpenFile(routeFileName);
  }, [routeFileName, requestOpenFile]);

  // Sync the URL when the active tab changes, so reload + share-link both
  // land back on the same view. Replace (not push) on tab activation so the
  // history stack doesn't fill with every tab click.
  const lastSyncedFileRef = useRef<string | null>(null);
  useEffect(() => {
    const target = openTabsState.active && (
      projectFileNames.has(openTabsState.active) || isLiveArtifactTabId(openTabsState.active)
    )
      ? openTabsState.active
      : null;
    if (target === lastSyncedFileRef.current) return;
    lastSyncedFileRef.current = target;
    navigate(
      { kind: 'project', projectId: project.id, fileName: target },
      { replace: true },
    );
  }, [openTabsState.active, projectFileNames, project.id]);

  const handleEnsureProject = useCallback(async (): Promise<string | null> => {
    return project.id;
  }, [project.id]);

  const composedSystemPrompt = useCallback(async (): Promise<string> => {
    let skillBody: string | undefined;
    let skillName: string | undefined;
    let skillMode: SkillSummary['mode'] | undefined;
    let designSystemBody: string | undefined;
    let designSystemTitle: string | undefined;

    if (project.skillId) {
      const summary = skills.find((s) => s.id === project.skillId);
      skillName = summary?.name;
      skillMode = summary?.mode;
      const cached = skillCache.current.get(project.skillId);
      if (cached !== undefined) {
        skillBody = cached;
      } else {
        const detail = await fetchSkill(project.skillId);
        if (detail) {
          skillBody = detail.body;
          skillCache.current.set(project.skillId, detail.body);
        }
      }
    }
    if (project.designSystemId) {
      const summary = designSystems.find((d) => d.id === project.designSystemId);
      designSystemTitle = summary?.title;
      const cached = designCache.current.get(project.designSystemId);
      if (cached !== undefined) {
        designSystemBody = cached;
      } else {
        const detail = await fetchDesignSystem(project.designSystemId);
        if (detail) {
          designSystemBody = detail.body;
          designCache.current.set(project.designSystemId, detail.body);
        }
      }
    }
    let template: ProjectTemplate | undefined;
    const tplId = project.metadata?.templateId;
    if (project.metadata?.kind === 'template' && tplId) {
      const cached = templateCache.current.get(tplId);
      if (cached) {
        template = cached;
      } else {
        const fetched = await getTemplate(tplId);
        if (fetched) {
          templateCache.current.set(tplId, fetched);
          template = fetched;
        }
      }
    }
    return composeSystemPrompt({
      skillBody,
      skillName,
      skillMode,
      designSystemBody,
      designSystemTitle,
      metadata: project.metadata,
      template,
    });
  }, [
    project.skillId,
    project.designSystemId,
    project.metadata,
    skills,
    designSystems,
  ]);

  const persistMessage = useCallback(
    (m: ChatMessage, targetConversationId = activeConversationId) => {
      if (!targetConversationId) return;
      void saveMessage(project.id, targetConversationId, m);
    },
    [project.id, activeConversationId],
  );

  const persistMessageById = useCallback(
    (messageId: string, targetConversationId = activeConversationId) => {
      if (!targetConversationId) return;
      setMessages((curr) => {
        const found = curr.find((m) => m.id === messageId);
        if (found) void saveMessage(project.id, targetConversationId, found);
        return curr;
      });
    },
    [project.id, activeConversationId],
  );

  const updateMessageById = useCallback(
    (
      messageId: string,
      updater: (message: ChatMessage) => ChatMessage,
      persist = false,
      targetConversationId = activeConversationId,
    ) => {
      setMessages((curr) => {
        let saved: ChatMessage | null = null;
        const next = curr.map((m) => {
          if (m.id !== messageId) return m;
          const updated = updater(m);
          saved = updated;
          return updated;
        });
        if (persist && saved && targetConversationId) {
          void saveMessage(project.id, targetConversationId, saved);
        }
        return next;
      });
    },
    [project.id, activeConversationId],
  );

  const refreshPreviewComments = useCallback(async () => {
    if (!activeConversationId) return;
    const next = await fetchPreviewComments(project.id, activeConversationId);
    setPreviewComments(next);
    setAttachedComments((current) =>
      current
        .map((attached) => next.find((comment) => comment.id === attached.id))
        .filter((comment): comment is PreviewComment => Boolean(comment)),
    );
  }, [project.id, activeConversationId]);

  const savePreviewComment = useCallback(
    async (target: PreviewCommentTarget, note: string, attachAfterSave: boolean) => {
      if (!activeConversationId) return null;
      const saved = await upsertPreviewComment(project.id, activeConversationId, { target, note });
      if (!saved) return null;
      setPreviewComments((current) => {
        const rest = current.filter((comment) => comment.id !== saved.id);
        return [saved, ...rest];
      });
      setAttachedComments((current) =>
        attachAfterSave ? mergeAttachedComments(current, saved) : current.map((comment) => comment.id === saved.id ? saved : comment),
      );
      return saved;
    },
    [project.id, activeConversationId],
  );

  const removePreviewComment = useCallback(
    async (commentId: string) => {
      if (!activeConversationId) return;
      const ok = await deletePreviewComment(project.id, activeConversationId, commentId);
      if (!ok) return;
      setPreviewComments((current) => current.filter((comment) => comment.id !== commentId));
      setAttachedComments((current) => removeAttachedComment(current, commentId));
    },
    [project.id, activeConversationId],
  );

  const attachPreviewComment = useCallback((comment: PreviewComment) => {
    setAttachedComments((current) => mergeAttachedComments(current, comment));
  }, []);

  const detachPreviewComment = useCallback((commentId: string) => {
    setAttachedComments((current) => removeAttachedComment(current, commentId));
  }, []);

  const patchAttachedStatuses = useCallback(
    async (attachments: ChatCommentAttachment[], status: PreviewComment['status']) => {
      if (!activeConversationId || attachments.length === 0) return;
      setPreviewComments((current) =>
        current.map((comment) =>
          attachments.some((attachment) => attachment.id === comment.id)
            ? { ...comment, status }
            : comment,
        ),
      );
      await Promise.all(
        attachments.map((attachment) =>
          patchPreviewCommentStatus(project.id, activeConversationId, attachment.id, status),
        ),
      );
      void refreshPreviewComments();
    },
    [project.id, activeConversationId, refreshPreviewComments],
  );

  const refreshSlideFeedback = useCallback(async () => {
    if (!activeConversationId) return;
    setSlideFeedback(await fetchSlideFeedback(project.id, activeConversationId));
  }, [project.id, activeConversationId]);

  const patchSlideFeedbackAttachments = useCallback(
    async (attachments: ChatSlideFeedbackAttachment[], status: SlideFeedback['status']) => {
      if (!activeConversationId || attachments.length === 0) return;
      const ids = new Set(attachments.map((attachment) => attachment.id));
      setSlideFeedback((current) =>
        current.map((item) =>
          ids.has(item.id) ? { ...item, status, updatedAt: Date.now() } : item,
        ),
      );
      await Promise.all(
        attachments.map((attachment) =>
          patchSlideFeedbackStatus(project.id, attachment.id, status),
        ),
      );
      void refreshSlideFeedback();
    },
    [project.id, activeConversationId, refreshSlideFeedback],
  );

  useEffect(() => {
    if (!daemonLive || !activeConversationId || streaming) return;
    let cancelled = false;

    const attachRecoverableRuns = async () => {
      const activeRuns = messages.some(
        (m) => m.role === 'assistant' && isActiveRunStatus(m.runStatus) && !m.runId,
      )
        ? await listActiveChatRuns(project.id, activeConversationId)
        : [];
      if (cancelled) return;
      const activeByMessage = new Map(
        activeRuns
          .filter((run) => run.assistantMessageId)
          .map((run) => [run.assistantMessageId!, run]),
      );

      for (const message of messages) {
        if (cancelled) return;
        if (message.role !== 'assistant') continue;
        if (!isActiveRunStatus(message.runStatus)) continue;
        const fallbackRun = !message.runId ? activeByMessage.get(message.id) : null;
        const runId = message.runId ?? fallbackRun?.id;
        if (!runId) continue;
        if (reattachControllersRef.current.has(runId)) continue;
        if (completedReattachRunsRef.current.has(runId)) continue;

        if (fallbackRun && !message.runId) {
          updateMessageById(
            message.id,
            (prev) => ({ ...prev, runId, runStatus: fallbackRun.status }),
            true,
          );
        }

        const status = fallbackRun ?? await fetchChatRunStatus(runId);
        if (cancelled) return;
        if (!status) {
          updateMessageById(
            message.id,
            (prev) => ({ ...prev, runStatus: 'failed', endedAt: prev.endedAt ?? Date.now() }),
            true,
          );
          completedReattachRunsRef.current.add(runId);
          continue;
        }
        updateMessageById(
          message.id,
          (prev) => ({ ...prev, runStatus: status.status }),
          true,
        );

        const controller = new AbortController();
        const cancelController = new AbortController();
        reattachControllersRef.current.set(runId, controller);
        reattachCancelControllersRef.current.set(runId, cancelController);
        if (!isTerminalRunStatus(status.status)) {
          abortRef.current = controller;
          cancelRef.current = cancelController;
          setStreaming(true);
        }

        let persistTimer: ReturnType<typeof setTimeout> | null = null;
        const persistSoon = () => {
          if (persistTimer) return;
          persistTimer = setTimeout(() => {
            persistTimer = null;
            persistMessageById(message.id);
          }, 500);
        };
        const persistNow = () => {
          if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          textBuffer.flush();
          persistMessageById(message.id);
        };
        const textBuffer = createBufferedTextUpdates({
          updateMessage: (updater) => updateMessageById(message.id, updater),
          persistSoon,
        });
        reattachTextBuffersRef.current.add(textBuffer);
        const unregisterTextBuffer = () => {
          reattachTextBuffersRef.current.delete(textBuffer);
        };

        void reattachDaemonRun({
          runId,
          signal: controller.signal,
          cancelSignal: cancelController.signal,
          initialLastEventId: message.lastRunEventId ?? null,
          handlers: {
            onDelta: (delta) => {
              textBuffer.appendContent(delta);
            },
            onAgentEvent: (ev) => {
              textBuffer.appendEvent(ev);
            },
            onDone: () => {
              textBuffer.flush();
              textBuffer.cancel();
              unregisterTextBuffer();
              updateMessageById(
                message.id,
                (prev) => ({ ...prev, runStatus: 'succeeded', endedAt: prev.endedAt ?? Date.now() }),
                true,
              );
              completedReattachRunsRef.current.add(runId);
              reattachControllersRef.current.delete(runId);
              reattachCancelControllersRef.current.delete(runId);
              if (abortRef.current === controller) abortRef.current = null;
              if (cancelRef.current === cancelController) cancelRef.current = null;
              setStreaming(false);
              persistNow();
              void refreshProjectFiles();
              onProjectsRefresh();
            },
            onError: (err) => {
              textBuffer.flush();
              textBuffer.cancel();
              unregisterTextBuffer();
              setError(err.message);
              updateMessageById(
                message.id,
                (prev) => ({ ...prev, runStatus: 'failed', endedAt: prev.endedAt ?? Date.now() }),
                true,
              );
              completedReattachRunsRef.current.add(runId);
              reattachControllersRef.current.delete(runId);
              reattachCancelControllersRef.current.delete(runId);
              if (abortRef.current === controller) abortRef.current = null;
              if (cancelRef.current === cancelController) cancelRef.current = null;
              setStreaming(false);
              persistNow();
            },
          },
          onRunStatus: (runStatus) => {
            textBuffer.flush();
            updateMessageById(
              message.id,
              (prev) => ({
                ...prev,
                runStatus,
                endedAt: isTerminalRunStatus(runStatus) ? prev.endedAt ?? Date.now() : prev.endedAt,
              }),
              true,
            );
            if (runStatus === 'canceled') {
              textBuffer.cancel();
              unregisterTextBuffer();
              completedReattachRunsRef.current.add(runId);
              reattachControllersRef.current.delete(runId);
              reattachCancelControllersRef.current.delete(runId);
              if (abortRef.current === controller) abortRef.current = null;
              if (cancelRef.current === cancelController) cancelRef.current = null;
              setStreaming(false);
              persistNow();
            }
          },
          onRunEventId: (lastRunEventId) => {
            textBuffer.flush();
            updateMessageById(message.id, (prev) => ({ ...prev, lastRunEventId }));
            persistSoon();
          },
        })
          .catch((err) => {
            if ((err as Error).name !== 'AbortError') {
              setError(err instanceof Error ? err.message : String(err));
            }
          })
          .finally(() => {
            textBuffer.flush();
            textBuffer.cancel();
            unregisterTextBuffer();
            if (persistTimer) clearTimeout(persistTimer);
            reattachControllersRef.current.delete(runId);
            reattachCancelControllersRef.current.delete(runId);
            if (abortRef.current === controller) abortRef.current = null;
            if (cancelRef.current === cancelController) cancelRef.current = null;
          });
      }
    };

    void attachRecoverableRuns();
    return () => {
      cancelled = true;
    };
  }, [
    daemonLive,
    activeConversationId,
    streaming,
    messages,
    project.id,
    updateMessageById,
    persistMessageById,
    refreshProjectFiles,
    onProjectsRefresh,
  ]);

  const handleSend = useCallback(
    async (
      prompt: string,
      attachments: ChatAttachment[],
      commentAttachments: ChatCommentAttachment[] = commentsToAttachments(attachedComments),
      vaultContextAttachments: ChatVaultContextAttachment[] = [],
      slideFeedbackAttachments: ChatSlideFeedbackAttachment[] = slideFeedback
        .filter((item) => item.status === 'queued')
        .map((item, index) => ({
          id: item.id,
          order: index + 1,
          kind: item.kind,
          slideId: item.slideId,
          pageIndex: item.pageIndex,
          line: item.line,
          column: item.column,
          targetLabel: item.targetLabel,
          note: item.note,
          source: item.source,
          payload: item.payload,
        })),
    ) => {
      if (
        !prompt.trim() &&
        attachments.length === 0 &&
        commentAttachments.length === 0 &&
        vaultContextAttachments.length === 0 &&
        slideFeedbackAttachments.length === 0
      ) {
        return false;
      }
      setNotice(null);
      const vaultTemplateReady = await lockVaultTemplateFromPrompt(prompt);
      if (!vaultTemplateReady) return false;
      const deckMediaPrompt = resolveDeckMediaIntentPrompt(
        prompt,
        messages.filter((message) => message.role === 'user').map((message) => message.content),
      );
      const deckMediaReady = await persistDeckMediaFromPrompt(deckMediaPrompt);
      if (!deckMediaReady) return false;
      if (!openSlideInspectActive) setChatCollapsed(false);
      let conversationId = activeConversationId;
      if (!conversationId) {
        const fresh = await createConversation(project.id);
        if (!fresh) {
          setError(
            'This project could not be loaded. It may have been deleted or the daemon is unavailable.',
          );
          void onProjectsRefresh();
          return false;
        }
        setConversations((curr) => [fresh, ...curr.filter((c) => c.id !== fresh.id)]);
        setActiveConversationId(fresh.id);
        conversationId = fresh.id;
      }
      setError(null);
      const startedAt = Date.now();
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
        createdAt: startedAt,
        attachments: attachments.length > 0 ? attachments : undefined,
        commentAttachments: commentAttachments.length > 0 ? commentAttachments : undefined,
        vaultContextAttachments: vaultContextAttachments.length > 0 ? vaultContextAttachments : undefined,
        slideFeedbackAttachments: slideFeedbackAttachments.length > 0 ? slideFeedbackAttachments : undefined,
      };
      const selectedAgent =
        config.mode === 'daemon' && config.agentId
          ? agentsById.get(config.agentId)
          : null;
      const selectedAgentChoice =
        config.mode === 'daemon' && config.agentId
          ? config.agentModels?.[config.agentId]
          : undefined;
      const assistantAgentId =
        config.mode === 'daemon'
          ? config.agentId ?? undefined
          : apiProtocolAgentId(config.apiProtocol);
      const assistantAgentName =
        config.mode === 'daemon'
          ? agentModelDisplayName(
              config.agentId,
              selectedAgent?.name,
              selectedAgentChoice?.model,
            )
          : apiProtocolModelLabel(config.apiProtocol, config.model);
      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        agentId: assistantAgentId,
        agentName: assistantAgentName,
        events: [],
        createdAt: startedAt,
        runStatus: config.mode === 'daemon' ? 'running' : undefined,
        startedAt,
      };
      const nextHistory = [...messages, userMsg];
      setMessages([...nextHistory, assistantMsg]);
      setStreaming(true);
      setArtifact(null);
      savedArtifactRef.current = null;
      onTouchProject();
      persistMessage(userMsg, conversationId);
      persistMessage(assistantMsg, conversationId);
      if (commentAttachments.length > 0) {
        void patchAttachedStatuses(commentAttachments, 'applying');
        setAttachedComments([]);
      }
      if (slideFeedbackAttachments.length > 0) {
        void patchSlideFeedbackAttachments(slideFeedbackAttachments, 'applying');
      }
      // If this is the first turn, derive a working title from the prompt
      // so the conversation is identifiable in the dropdown without a
      // round-trip through the agent.
      if (messages.length === 0) {
        const title = prompt.slice(0, 60).trim();
        if (title) {
          setConversations((curr) =>
            curr.map((c) =>
              c.id === conversationId ? { ...c, title } : c,
            ),
          );
          void patchConversation(project.id, conversationId, { title });
        }
      }

      // Snapshot the file list at turn-start so we can diff after the
      // agent finishes and surface anything new (e.g. a generated .pptx)
      // as download chips on the assistant message.
      const beforeFileNames = new Set(projectFiles.map((f) => f.name));

      const parser = createArtifactParser();
      let liveHtml = '';

      const updateAssistant = (updater: (prev: ChatMessage) => ChatMessage) => {
        setMessages((curr) =>
          curr.map((m) => (m.id === assistantId ? updater(m) : m)),
        );
      };
      let persistTimer: ReturnType<typeof setTimeout> | null = null;
      const persistAssistantSoon = () => {
        if (persistTimer) return;
        persistTimer = setTimeout(() => {
          persistTimer = null;
          persistMessageById(assistantId, conversationId);
        }, 500);
      };
      const pushEvent = (ev: AgentEvent) => {
        textBuffer.flush();
        updateAssistant((prev) => ({ ...prev, events: [...(prev.events ?? []), ev] }));
        if (ev.kind === 'live_artifact') {
          setLiveArtifactEvents((prev) => appendLiveArtifactEventItem(prev, ev));
          void refreshLiveArtifacts().then(() => {
            if (ev.action !== 'deleted') requestOpenFile(liveArtifactTabId(ev.artifactId));
          });
          onProjectsRefresh();
          return;
        }
        if (ev.kind === 'live_artifact_refresh') {
          setLiveArtifactEvents((prev) => appendLiveArtifactEventItem(prev, ev));
          void refreshLiveArtifacts();
          onProjectsRefresh();
          return;
        }
        persistAssistantSoon();
        persistAssistantSoon();
        // Track Write tool invocations so we can auto-open the destination
        // file the moment the agent finishes writing it. The file-creating
        // tools we care about: Write (new file), Edit (existing file —
        // surfacing the freshly-modified file is also useful).
        if (ev.kind === 'tool_use' && (ev.name === 'Write' || ev.name === 'Edit')) {
          const filePath = (ev.input as { file_path?: unknown } | null)?.file_path;
          if (typeof filePath === 'string' && filePath.length > 0) {
            // Preserve the full path so decideAutoOpenAfterWrite can do a
            // path-suffix match against the project's relative file paths.
            // Reducing to a basename here would lose the segment alignment
            // we need to disambiguate same-basename collisions across the
            // project tree and outside it.
            pendingWritesRef.current.set(ev.id, filePath);
          }
        }
        if (ev.kind === 'tool_result') {
          const filePath = pendingWritesRef.current.get(ev.toolUseId);
          if (filePath) {
            pendingWritesRef.current.delete(ev.toolUseId);
            if (!ev.isError) {
              // Refresh first so FileWorkspace's file list (and the tab
              // body) sees the new content before we ask it to focus.
              // Only auto-open if the file actually landed in the project's
              // file list — otherwise an out-of-project Write (e.g. an
              // upstream repo edit) would spawn a permanent placeholder tab.
              void refreshProjectFiles().then((nextFiles) => {
                const decision = decideAutoOpenAfterWrite(filePath, nextFiles);
                if (decision.shouldOpen && decision.fileName) {
                  requestOpenFile(decision.fileName);
                }
              });
            }
          }
        }
      };

      const applyContentDelta = (delta: string) => {
        for (const ev of parser.feed(delta)) {
          if (ev.type === 'artifact:start') {
            liveHtml = '';
            setArtifact({
              identifier: ev.identifier,
              artifactType: ev.artifactType,
              title: ev.title,
              html: '',
            });
          } else if (ev.type === 'artifact:chunk') {
            liveHtml += ev.delta;
            setArtifact((prev) =>
              prev
                ? { ...prev, html: liveHtml }
                : {
                    identifier: ev.identifier,
                    title: '',
                    html: liveHtml,
                  },
            );
          } else if (ev.type === 'artifact:end') {
            setArtifact((prev) => (prev ? { ...prev, html: ev.fullContent } : null));
          }
        }
      };

      const textBuffer = createBufferedTextUpdates({
        updateMessage: updateAssistant,
        persistSoon: persistAssistantSoon,
        onContentDelta: applyContentDelta,
      });
      sendTextBufferRef.current = textBuffer;

      const controller = new AbortController();
      const cancelController = new AbortController();
      abortRef.current = controller;
      cancelRef.current = cancelController;
      const handlers = {
        onDelta: textBuffer.appendContent,
        onAgentEvent: (ev: AgentEvent) => {
          if (ev.kind === 'text') textBuffer.appendTextEvent(ev.text);
          else pushEvent(ev);
        },
        onDone: () => {
          textBuffer.flush();
          textBuffer.cancel();
          cancelSendTextBuffer();
          for (const ev of parser.flush()) {
            if (ev.type === 'artifact:end') {
              setArtifact((prev) => (prev ? { ...prev, html: ev.fullContent } : null));
            }
          }
          updateAssistant((prev) => ({
            ...prev,
            endedAt: Date.now(),
            runStatus: config.mode === 'api' || prev.runId ? 'succeeded' : prev.runStatus,
          }));
          if (commentAttachments.length > 0) {
            void patchAttachedStatuses(commentAttachments, 'needs_review');
          }
          if (slideFeedbackAttachments.length > 0) {
            void patchSlideFeedbackAttachments(slideFeedbackAttachments, 'needs_review');
          }
          setStreaming(false);
          abortRef.current = null;
          cancelRef.current = null;
          // Persist the finished artifact to the project folder so it shows
          // up as a real tab (not just the synthetic "live" stream).
          setArtifact((prev) => {
            if (!prev || !prev.html) return prev;
            void persistArtifact(prev);
            return prev;
          });
          // Refetch the file list directly (rather than just bumping the
          // refresh signal) so we can diff against the pre-turn snapshot
          // and attach the new files to the assistant message as download
          // chips.
          void refreshProjectFiles().then((nextFiles) => {
            const produced = nextFiles.filter((f) => !beforeFileNames.has(f.name));
            setMessages((curr) => {
              const updated = curr.map((m) =>
                m.id === assistantId
                  ? produced.length > 0
                    ? { ...m, producedFiles: produced }
                    : m
                  : m,
              );
              const finalized = updated.find((m) => m.id === assistantId);
              if (finalized) persistMessage(finalized, conversationId);
              return updated;
            });
          });
          onProjectsRefresh();
        },
        onError: (err: Error) => {
          textBuffer.flush();
          textBuffer.cancel();
          cancelSendTextBuffer();
          setError(err.message);
          updateAssistant((prev) => ({
            ...prev,
            endedAt: Date.now(),
            runStatus: config.mode === 'api' || prev.runId || isActiveRunStatus(prev.runStatus)
              ? 'failed'
              : prev.runStatus,
          }));
          if (commentAttachments.length > 0) {
            void patchAttachedStatuses(commentAttachments, 'failed');
          }
          if (slideFeedbackAttachments.length > 0) {
            void patchSlideFeedbackAttachments(slideFeedbackAttachments, 'failed');
          }
          setStreaming(false);
          abortRef.current = null;
          cancelRef.current = null;
          setMessages((curr) => {
            const finalized = curr.find((m) => m.id === assistantId);
            if (finalized) persistMessage(finalized, conversationId);
            return curr;
          });
          void refreshProjectFiles();
        },
      };

      if (config.mode === 'daemon') {
        if (!config.agentId) {
          handlers.onError(new Error('Pick a local agent first (top bar).'));
          return;
        }
        const choice = selectedAgentChoice;
        void streamViaDaemon({
          agentId: config.agentId,
          history: nextHistory,
          signal: controller.signal,
          cancelSignal: cancelController.signal,
          handlers,
          projectId: project.id,
          conversationId,
          assistantMessageId: assistantId,
          clientRequestId: crypto.randomUUID(),
          skillId: project.skillId ?? null,
          designSystemId: project.designSystemId ?? null,
          attachments: attachments.map((a) => a.path),
          commentAttachments,
          slideFeedbackAttachments,
          vaultContextAttachments,
          model: choice?.model ?? null,
          reasoning: choice?.reasoning ?? null,
          onRunCreated: (runId) => {
            updateMessageById(
              assistantId,
              (prev) => ({ ...prev, runId, runStatus: 'queued' }),
              true,
              conversationId,
            );
          },
          onRunStatus: (runStatus) => {
            updateMessageById(
              assistantId,
              (prev) => ({
                ...prev,
                runStatus,
                endedAt: isTerminalRunStatus(runStatus) ? prev.endedAt ?? Date.now() : prev.endedAt,
              }),
              true,
              conversationId,
            );
          },
          onRunEventId: (lastRunEventId) => {
            updateMessageById(assistantId, (prev) => ({ ...prev, lastRunEventId }));
            persistAssistantSoon();
          },
        });
      } else {
        const systemPrompt = await composedSystemPrompt();
        const apiHistory = historyWithCommentAttachmentContext(nextHistory, userMsg.id);
        pushEvent({ kind: 'status', label: 'requesting', detail: config.model });
        void streamMessage(config, systemPrompt, apiHistory, controller.signal, {
          onDelta: (delta) => {
            handlers.onDelta(delta);
            handlers.onAgentEvent({ kind: 'text', text: delta });
          },
          onDone: handlers.onDone,
          onError: handlers.onError,
        });
      }
      return true;
    },
    [
      attachedComments,
      slideFeedback,
      activeConversationId,
      messages,
      config,
      agentsById,
      composedSystemPrompt,
      onTouchProject,
      project.id,
      projectFiles,
      lockVaultTemplateFromPrompt,
      persistDeckMediaFromPrompt,
      refreshProjectFiles,
      refreshLiveArtifacts,
      requestOpenFile,
      persistMessage,
      persistMessageById,
      patchAttachedStatuses,
      patchSlideFeedbackAttachments,
      updateMessageById,
      onProjectsRefresh,
    ],
  );

  const persistArtifact = useCallback(
    async (art: Artifact) => {
      const baseName = (art.identifier || art.title || 'artifact')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'artifact';
      const ext = artifactExtensionFor(art);
      // Pick a name that doesn't collide with an existing project file.
      // The first run uses `<base>.<ext>`; subsequent runs append `-2`, `-3`…
      // so prior artifacts aren't silently overwritten.
      const existing = new Set(projectFiles.map((f) => f.name));
      let fileName = `${baseName}${ext}`;
      let n = 2;
      while (existing.has(fileName) && savedArtifactRef.current !== fileName) {
        fileName = `${baseName}-${n}${ext}`;
        n += 1;
      }
      if (savedArtifactRef.current === fileName) return;
      savedArtifactRef.current = fileName;
      const title = art.title || art.identifier || fileName;
      const metadata = {
        identifier: art.identifier,
        artifactType: art.artifactType,
        inferred: false,
      };
      const manifest =
        ext === '.html'
          ? createHtmlArtifactManifest({
              entry: fileName,
              title,
              sourceSkillId: project.skillId ?? undefined,
              designSystemId: project.designSystemId,
              metadata,
            })
          : inferLegacyManifest({
              entry: fileName,
              title,
              metadata: {
                ...metadata,
                sourceSkillId: project.skillId ?? undefined,
                designSystemId: project.designSystemId,
              },
            });
      const file = await writeProjectTextFile(project.id, fileName, art.html, {
        artifactManifest: manifest ?? undefined,
      });
      if (file) {
        setFilesRefresh((n) => n + 1);
        // Auto-open the freshly-persisted artifact as a tab so the user
        // sees it without an extra click. The Write-tool path already does
        // this for tool-emitted files; this handles the artifact-tag path.
        requestOpenFile(file.name);
      }
    },
    [project.id, projectFiles, requestOpenFile],
  );

  const handleContinueRemainingTasks = useCallback(
    (_assistantMessage: ChatMessage, todos: TodoItem[]) => {
      if (streaming || todos.length === 0) return;
      const remainingList = todos
        .map((todo, i) => {
          const label =
            todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
          return `${i + 1}. [${todo.status}] ${label}`;
        })
        .join('\n');
      const prompt =
        'Continue the remaining unfinished tasks from the previous run. ' +
        'Do not redo completed work. Focus only on these unfinished todos:\n\n' +
        `${remainingList}\n\n` +
        'Before making changes, inspect the current project files as needed. ' +
        'Update TodoWrite as you complete each remaining task.';
      void handleSend(prompt, [], []);
    },
    [streaming, handleSend],
  );

  const handleExportAsPptx = useCallback(
    (fileName: string) => {
      if (streaming) return;
      const baseTitle = fileName.replace(/\.html?$/i, '') || fileName;
      const prompt =
        `Export @${fileName} as an editable PPTX file titled "${baseTitle}".\n\n` +
        `**Generate.** Use python-pptx (preferred — full XML control). Apply the ` +
        `footer-rail + cursor-flow discipline from \`skills/pptx-html-fidelity-audit/SKILL.md\` ` +
        `Step 4 from the start: define \`CONTENT_MAX_Y = 6.70"\` and \`FOOTER_TOP = 6.85"\` ` +
        `as constants, route every content block through a \`Cursor\` that refuses to cross ` +
        `the rail, and use budget centering (not \`MARGIN_TOP\`) for hero/cover slides. ` +
        `Preserve \`<em>\` / \`<i>\` as \`italic=True\` on Latin runs only — never on CJK. ` +
        `Set the \`<a:latin>\` and \`<a:ea>\` typeface slots explicitly so Chinese runs ` +
        `don't fall back to Microsoft JhengHei.\n\n` +
        `**Verify (mandatory gate).** After writing, run ` +
        `\`python skills/pptx-html-fidelity-audit/scripts/verify_layout.py "${baseTitle}.pptx"\` ` +
        `(quote the path — filenames may contain spaces). Zero rail violations is the gate ` +
        `for "shippable". If violations remain, walk Steps 2-4 of the SKILL.md ` +
        `(extract dump → audit table → re-export) — do not declare done by eyeballing the ` +
        `deck. If 🟡 typography issues surface (italic missing, unexpected \`Calibri\` / ` +
        `\`Microsoft JhengHei\` in the XML), consult ` +
        `\`skills/pptx-html-fidelity-audit/references/font-discipline.md\` for the ` +
        `five-layer font audit.\n\n` +
        `**Customizing rails.** The default \`CONTENT_MAX_Y = 6.70"\` / ` +
        `\`FOOTER_TOP = 6.85"\` constants suit a 16:9 canvas with a slim footer. If the ` +
        `design system needs different rails (wider footer, 4:3 canvas), pass ` +
        `\`--content-max-y\` / \`--canvas-h\` to \`verify_layout.py\` and update the matching ` +
        `constants in the export script — see \`references/layout-discipline.md\` §1.\n\n` +
        `If \`python-pptx\` or the verifier is unavailable in this environment, say so ` +
        `explicitly — don't claim fidelity is correct without evidence.\n\n` +
        `Save into the current project folder (this conversation's working directory) as ` +
        `\`${baseTitle}.pptx\`. Report the on-disk path and a 1-line fidelity summary ` +
        `(e.g. "0 rail violations across 14 slides") when done.`;
      const attachment: ChatAttachment = {
        path: fileName,
        name: fileName,
        kind: 'file',
      };
      void handleSend(prompt, [attachment], []);
    },
    [streaming, handleSend],
  );

  const handleStop = useCallback(() => {
    const stoppedAt = Date.now();
    cancelSendTextBuffer(true);
    cancelReattachTextBuffers(true);
    cancelRef.current?.abort();
    cancelRef.current = null;
    for (const controller of reattachCancelControllersRef.current.values()) {
      controller.abort();
    }
    reattachCancelControllersRef.current.clear();
    abortRef.current?.abort();
    abortRef.current = null;
    for (const controller of reattachControllersRef.current.values()) {
      controller.abort();
    }
    reattachControllersRef.current.clear();
    setStreaming(false);
    setMessages((curr) => {
      const finalized: ChatMessage[] = [];
      const next = curr.map((m) => {
        if (m.role !== 'assistant') return m;
        if (isActiveRunStatus(m.runStatus)) {
          const updated = { ...m, runStatus: 'canceled' as const, endedAt: m.endedAt ?? stoppedAt };
          finalized.push(updated);
          return updated;
        }
        if (m.endedAt === undefined) {
          const updated = { ...m, endedAt: stoppedAt };
          finalized.push(updated);
          return updated;
        }
        return m;
      });
      for (const message of finalized) persistMessage(message);
      return next;
    });
  }, [cancelSendTextBuffer, cancelReattachTextBuffers, persistMessage]);

  const handleNewConversation = useCallback(async () => {
    const fresh = await createConversation(project.id);
    if (!fresh) return;
    setConversations((curr) => [fresh, ...curr]);
    setActiveConversationId(fresh.id);
  }, [project.id]);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
  }, []);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const ok = await deleteConversationApi(project.id, id);
      if (!ok) return;
      setConversations((curr) => {
        const next = curr.filter((c) => c.id !== id);
        if (next.length === 0) {
          // Re-seed so the project always has at least one conversation
          // to write into.
          void createConversation(project.id).then((fresh) => {
            if (fresh) {
              setConversations([fresh]);
              setActiveConversationId(fresh.id);
            }
          });
        } else if (id === activeConversationId) {
          setActiveConversationId(next[0]!.id);
        }
        return next;
      });
    },
    [project.id, activeConversationId],
  );

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim() || null;
      setConversations((curr) =>
        curr.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
      );
      await patchConversation(project.id, id, { title: trimmed });
    },
    [project.id],
  );

  const handleProjectRename = useCallback(
    (newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === project.name) return;
      const updated: Project = { ...project, name: trimmed, updatedAt: Date.now() };
      onProjectChange(updated);
      void patchProject(project.id, { name: trimmed });
    },
    [project, onProjectChange],
  );

  const projectMeta = useMemo(() => {
    const skill = skills.find((s) => s.id === project.skillId)?.name;
    const ds = designSystems.find((d) => d.id === project.designSystemId)?.title;
    const vault = project.metadata?.vaultTemplate?.title
      ? `Vault: ${project.metadata.vaultTemplate.title}`
      : project.metadata?.kind === 'deck'
        ? 'Style: choose in chat'
        : null;
    return [skill ?? (project.metadata?.kind === 'deck' ? 'SFA deck' : null), vault, ds].filter(Boolean).join(' · ') || t('project.metaFreeform');
  }, [skills, designSystems, project.skillId, project.designSystemId, project.metadata?.kind, project.metadata?.vaultTemplate?.title, t]);

  const isDeck = useMemo(
    () => project.metadata?.kind === 'deck' || skills.find((s) => s.id === project.skillId)?.mode === 'deck',
    [skills, project.metadata?.kind, project.skillId],
  );

  // Hand the pending prompt to ChatPane exactly once. We snapshot the value
  // into local state on mount so it survives the ChatPane remount triggered
  // when `activeConversationId` resolves from `null` to a real id (the
  // `key={activeConversationId}` on ChatPane otherwise wipes the freshly
  // seeded composer draft). Once the conversation id is in place — meaning
  // ChatPane has remounted with the seed still available — we clear both
  // the local snapshot and the persisted pendingPrompt so future
  // conversation switches don't keep re-seeding the composer.
  const [initialDraft, setInitialDraft] = useState<string | undefined>(
    project.pendingPrompt,
  );
  useEffect(() => {
    if (initialDraft && activeConversationId) {
      setInitialDraft(undefined);
    }
  }, [initialDraft, activeConversationId]);
  useEffect(() => {
    if (project.pendingPrompt) onClearPendingPrompt();
  }, [project.pendingPrompt, onClearPendingPrompt]);

  return (
    <div className="app">
      <AppChromeHeader
        onBack={onBack}
        backLabel={t('project.backToProjects')}
        actions={(
          <AvatarMenu
            config={config}
            agents={agents}
            daemonLive={daemonLive}
            onModeChange={onModeChange}
            onAgentChange={onAgentChange}
            onAgentModelChange={onAgentModelChange}
            onOpenSettings={onOpenSettings}
            onRefreshAgents={onRefreshAgents}
            onBack={onBack}
          />
        )}
      >
        <div className="app-project-title">
            <span
              className="title editable"
              data-testid="project-title"
              tabIndex={0}
              role="textbox"
              suppressContentEditableWarning
              contentEditable
              onBlur={(e) => handleProjectRename(e.currentTarget.textContent ?? '')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).blur();
                }
              }}
            >
              {project.name}
            </span>
            <span className="meta" data-testid="project-meta">{projectMeta}</span>
        </div>
      </AppChromeHeader>
      <div className={`split${chatCollapsed ? ' chat-collapsed' : ''}`}>
        <ChatPane
          // The conversation id is part of the key so switching conversations
          // resets internal scroll/draft state inside ChatPane and ChatComposer.
          key={activeConversationId ?? 'no-conv'}
          messages={messages}
          streaming={streaming}
          collapsed={chatCollapsed}
          onCollapsedChange={handleChatCollapsedChange}
          error={error}
          notice={notice}
          projectId={project.id}
          projectFiles={projectFiles}
          projectFileNames={projectFileNames}
          onEnsureProject={handleEnsureProject}
          previewComments={previewComments}
          attachedComments={attachedComments}
          onAttachComment={attachPreviewComment}
          onDetachComment={detachPreviewComment}
          onDeleteComment={(commentId) => void removePreviewComment(commentId)}
          onSend={handleSend}
          onStop={handleStop}
          onRequestOpenFile={requestOpenFile}
          initialDraft={initialDraft}
          onSubmitForm={(text) => {
            if (streaming) return;
            void handleSend(text, [], []);
          }}
          onVaultTemplateSelect={handleVaultTemplateSelect}
          onContinueRemainingTasks={handleContinueRemainingTasks}
          onNewConversation={handleNewConversation}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameConversation}
          onOpenSettings={onOpenSettings}
          projectMetadata={project.metadata}
          onProjectMetadataChange={(metadata) => {
            onProjectChange({ ...project, metadata });
          }}
        />
        <FileWorkspace
          projectId={project.id}
          files={projectFiles}
          liveArtifacts={liveArtifacts}
          onRefreshFiles={() => {
            void refreshWorkspaceItems();
          }}
          isDeck={isDeck}
          onExportAsPptx={handleExportAsPptx}
          streaming={streaming}
          openRequest={openRequest}
          liveArtifactEvents={liveArtifactEvents}
          tabsState={openTabsState}
          onTabsStateChange={persistTabsState}
          previewComments={previewComments}
          slideFeedback={slideFeedback}
          activeConversationId={activeConversationId}
          onSavePreviewComment={savePreviewComment}
          onRemovePreviewComment={removePreviewComment}
          onRefreshSlideFeedback={refreshSlideFeedback}
          onApplySlideFeedback={(prompt, attachments) => {
            if (streaming) return;
            void handleSend(prompt, [], [], [], attachments);
          }}
          onOpenSlideInspectActiveChange={handleOpenSlideInspectActiveChange}
        />
      </div>
    </div>
  );
}

function artifactExtensionFor(art: Artifact): '.html' | '.jsx' | '.tsx' {
  const type = (art.artifactType || '').toLowerCase();
  const identifier = (art.identifier || '').toLowerCase();
  if (type.includes('tsx') || identifier.endsWith('.tsx')) return '.tsx';
  if (type.includes('jsx') || type.includes('react') || identifier.endsWith('.jsx')) {
    return '.jsx';
  }
  return '.html';
}

function assistantAgentDisplayName(
  agentId: string | null,
  fallbackName?: string,
): string | undefined {
  return agentDisplayName(agentId, fallbackName) ?? undefined;
}

function isTerminalRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function isActiveRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'queued' || status === 'running';
}

type BufferedTextUpdates = ReturnType<typeof createBufferedTextUpdates>;

function createBufferedTextUpdates({
  updateMessage,
  persistSoon,
  onContentDelta,
}: {
  updateMessage: (updater: (prev: ChatMessage) => ChatMessage) => void;
  persistSoon: () => void;
  onContentDelta?: (delta: string) => void;
}) {
  let pendingContentDelta = '';
  let pendingTextEventDelta = '';
  let flushFrame: number | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let flushing = false;
  let needsFlush = false;
  const hasDocument = typeof document !== 'undefined';

  const cancelScheduledFlush = () => {
    if (flushFrame !== null) {
      cancelAnimationFrame(flushFrame);
      flushFrame = null;
    }
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const flush = () => {
    if (disposed) return;
    if (flushing) {
      needsFlush = true;
      return;
    }
    cancelScheduledFlush();
    if (!pendingContentDelta && !pendingTextEventDelta && !needsFlush) return;
    flushing = true;
    needsFlush = false;
    const contentDelta = pendingContentDelta;
    const textEventDelta = pendingTextEventDelta;
    pendingContentDelta = '';
    pendingTextEventDelta = '';
    try {
      updateMessage((prev) => ({
        ...prev,
        content: prev.content + contentDelta,
        events: textEventDelta
          ? [...(prev.events ?? []), { kind: 'text', text: textEventDelta }]
          : prev.events,
      }));
      persistSoon();
      if (contentDelta) onContentDelta?.(contentDelta);
    } finally {
      flushing = false;
    }
    if (pendingContentDelta || pendingTextEventDelta || needsFlush) {
      needsFlush = false;
      scheduleFlush();
    }
  };

  const scheduleFlush = () => {
    if (disposed || flushFrame !== null || flushTimer !== null) return;
    flushFrame = requestAnimationFrame(() => {
      flushFrame = null;
      flush();
    });
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 250);
  };

  const appendContent = (delta: string) => {
    if (disposed) return;
    pendingContentDelta += delta;
    needsFlush = true;
    scheduleFlush();
  };

  const appendTextEvent = (delta: string) => {
    if (disposed) return;
    pendingTextEventDelta += delta;
    needsFlush = true;
    scheduleFlush();
  };

  const appendEvent = (ev: AgentEvent) => {
    if (disposed) return;
    if (ev.kind === 'text') {
      appendTextEvent(ev.text);
      return;
    }
    flush();
    updateMessage((prev) => ({ ...prev, events: [...(prev.events ?? []), ev] }));
    persistSoon();
  };

  const cancel = () => {
    disposed = true;
    cancelScheduledFlush();
    pendingContentDelta = '';
    pendingTextEventDelta = '';
    needsFlush = false;
    if (hasDocument) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  }

  if (hasDocument) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return { appendContent, appendTextEvent, appendEvent, flush, cancel };
}
