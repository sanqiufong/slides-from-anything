import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { deleteLiveArtifact, fetchLiveArtifacts, fetchOpenSlideDesign, fetchOpenSlideModule } from '../providers/registry';
import type {
  DesignSystemSummary,
  LiveArtifactSummary,
  Project,
  ProjectDisplayStatus,
  SkillSummary,
} from '../types';
import {
  evaluateOpenSlideRuntime,
  OpenSlideCanvas,
  OpenSlideRuntimePageView,
} from './FileWorkspace';
import { Icon } from './Icon';
import { LiveArtifactBadges } from './LiveArtifactBadges';

type SubTab = 'recent' | 'yours';
type ViewMode = 'grid' | 'kanban';
export type DesignSortMode =
  | 'created-desc'
  | 'created-asc'
  | 'updated-desc'
  | 'name-asc'
  | 'name-desc'
  | 'status';

export type DesignListItem =
  | { type: 'project'; project: Project; updatedAt: number }
  | { type: 'live-artifact'; project: Project; liveArtifact: LiveArtifactSummary; updatedAt: number };

const DESIGNS_VIEW_STORAGE_KEY = 'od:designs:view';
export const DEFAULT_DESIGN_SORT_MODE: DesignSortMode = 'created-desc';
const DESIGN_SORT_OPTIONS = [
  'created-desc',
  'created-asc',
  'updated-desc',
  'name-asc',
  'name-desc',
  'status',
] as const satisfies readonly DesignSortMode[];

export const STATUS_ORDER = [
  'not_started',
  'running',
  'awaiting_input',
  'succeeded',
  'failed',
  'canceled',
] as const satisfies readonly ProjectDisplayStatus[];

export const STATUS_LABEL_KEYS = {
  not_started: 'designs.status.notStarted',
  queued: 'designs.status.queued',
  running: 'designs.status.running',
  awaiting_input: 'designs.status.awaitingInput',
  succeeded: 'designs.status.succeeded',
  failed: 'designs.status.failed',
  canceled: 'designs.status.canceled',
} as const satisfies Record<ProjectDisplayStatus, Parameters<ReturnType<typeof useT>>[0]>;

export const DESIGN_SORT_LABEL_KEYS = {
  'created-desc': 'designs.sort.createdDesc',
  'created-asc': 'designs.sort.createdAsc',
  'updated-desc': 'designs.sort.updatedDesc',
  'name-asc': 'designs.sort.nameAsc',
  'name-desc': 'designs.sort.nameDesc',
  status: 'designs.sort.status',
} as const satisfies Record<DesignSortMode, Parameters<ReturnType<typeof useT>>[0]>;

interface Props {
  projects: Project[];
  skills: SkillSummary[];
  designSystems: DesignSystemSummary[];
  onOpen: (id: string) => void;
  onOpenLiveArtifact: (projectId: string, artifactId: string) => void;
  onDelete: (id: string) => void;
}

export function DesignsTab({
  projects,
  onOpen,
  onOpenLiveArtifact,
  onDelete,
}: Props) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const [sub, setSub] = useState<SubTab>('recent');
  const [sortMode, setSortMode] = useState<DesignSortMode>(DEFAULT_DESIGN_SORT_MODE);
  const [liveArtifactsByProject, setLiveArtifactsByProject] = useState<Record<string, LiveArtifactSummary[]>>({});
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'grid';
    try {
      const storedView = window.localStorage.getItem(DESIGNS_VIEW_STORAGE_KEY);
      return storedView === 'grid' || storedView === 'kanban' ? storedView : 'grid';
    } catch {
      return 'grid';
    }
  });

  useEffect(() => {
    let cancelled = false;
    const projectIds = projects.map((project) => project.id);
    if (projectIds.length === 0) {
      setLiveArtifactsByProject({});
      return;
    }

    void Promise.all(
      projectIds.map(async (projectId) => [projectId, await fetchLiveArtifacts(projectId)] as const),
    ).then((liveEntries) => {
      if (cancelled) return;
      setLiveArtifactsByProject(Object.fromEntries(liveEntries));
    });

    return () => {
      cancelled = true;
    };
  }, [projects]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DESIGNS_VIEW_STORAGE_KEY, view);
    } catch {}
  }, [view]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list: DesignListItem[] = projects.map((project) => ({
      type: 'project',
      project,
      updatedAt: project.updatedAt,
    }));
    const liveItems = projects.flatMap((project) =>
      (liveArtifactsByProject[project.id] ?? []).map((liveArtifact) => ({
        type: 'live-artifact' as const,
        project,
        liveArtifact,
        updatedAt: parseLiveArtifactTimestamp(liveArtifact.updatedAt, project.updatedAt),
      })),
    );
    list = [...list, ...liveItems];
    if (q) {
      list = list.filter((item) => {
        if (item.project.name.toLowerCase().includes(q)) return true;
        return item.type === 'live-artifact' && item.liveArtifact.title.toLowerCase().includes(q);
      });
    }
    return sortDesignListItemsForDisplay(list, sortMode);
  }, [projects, liveArtifactsByProject, filter, sortMode]);

  const filteredProjects = useMemo(
    () => filtered.filter((item): item is Extract<DesignListItem, { type: 'project' }> => item.type === 'project'),
    [filtered],
  );

  const handleDeleteLiveArtifact = async (projectId: string, artifact: LiveArtifactSummary) => {
    if (!confirm(`${t('common.delete')} "${artifact.title}"?`)) return;
    const ok = await deleteLiveArtifact(projectId, artifact.id);
    if (!ok) return;
    setLiveArtifactsByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? []).filter((candidate) => candidate.id !== artifact.id),
    }));
  };

  return (
    <div className={`tab-panel${view === 'kanban' ? ' design-kanban-view' : ''}`}>
      <div className="tab-panel-toolbar">
        <div className="toolbar-left">
          <div className="subtab-pill" role="group" aria-label={t('designs.filterAria')}>
            <button aria-pressed={sub === 'recent'} className={sub === 'recent' ? 'active' : ''} onClick={() => setSub('recent')}>
              {t('designs.subRecent')}
            </button>
            <button aria-pressed={sub === 'yours'} className={sub === 'yours' ? 'active' : ''} onClick={() => setSub('yours')}>
              {t('designs.subYours')}
            </button>
          </div>
        </div>
        <div className="toolbar-right">
          <div className="design-sort-control">
            <Icon name="sliders" size={13} />
            <select
              aria-label={t('designs.sortAria')}
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as DesignSortMode)}
            >
              {DESIGN_SORT_OPTIONS.map((mode) => (
                <option key={mode} value={mode}>
                  {t(DESIGN_SORT_LABEL_KEYS[mode])}
                </option>
              ))}
            </select>
          </div>
          <div className="toolbar-search">
            <span className="search-icon" aria-hidden>
              <Icon name="search" size={13} />
            </span>
            <input placeholder={t('designs.searchPlaceholder')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="subtab-pill" role="group" aria-label={t('designs.viewToggleAria')}>
            <button
              aria-pressed={view === 'grid'}
              className={view === 'grid' ? 'active' : ''}
              onClick={() => setView('grid')}
              title={t('designs.viewGrid')}
              data-testid="designs-view-grid"
            >
              <Icon name="grid" size={14} />
            </button>
            <button
              aria-pressed={view === 'kanban'}
              className={view === 'kanban' ? 'active' : ''}
              onClick={() => setView('kanban')}
              title={t('designs.viewKanban')}
              data-testid="designs-view-kanban"
            >
              <Icon name="kanban" size={14} />
            </button>
          </div>
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="tab-empty">{projects.length === 0 ? t('designs.emptyNoProjects') : t('designs.emptyNoMatch')}</div>
      ) : view === 'grid' ? (
        <div className="design-grid">
          {filtered.map((item) => {
            const p = item.project;
            if (item.type === 'live-artifact') {
              const artifact = item.liveArtifact;
              return (
                <div
                  key={`live:${artifact.id}`}
                  className={`design-card live-artifact-card status-${artifact.status} refresh-${artifact.refreshStatus}`}
                >
                  <button
                    type="button"
                    className="design-card-hit-target"
                    title={artifact.title}
                    aria-label={artifact.title}
                    onClick={() => onOpenLiveArtifact(p.id, artifact.id)}
                  />
                  <button
                    type="button"
                    className="design-card-close"
                    title={t('common.delete')}
                    aria-label={`${t('common.delete')} ${artifact.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteLiveArtifact(p.id, artifact);
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                  <div className="design-card-thumb live-artifact-thumb" aria-hidden>
                    <span className="live-artifact-thumb-glyph">●</span>
                  </div>
                  <div className="design-card-meta-block">
                    <LiveArtifactBadges className="design-card-badges" status={artifact.status} refreshStatus={artifact.refreshStatus} />
                    <div className="design-card-name" title={artifact.title}>{artifact.title}</div>
                    <div className="design-card-meta">
                      <span className="ds">{p.name}</span>
                      {' · '}
                      {artifactStatusLabel(artifact.status, artifact.refreshStatus, t)}
                      {' · '}
                      {relativeTime(item.updatedAt, t)}
                    </div>
                  </div>
                </div>
              );
            }

            const liveCount = liveArtifactsByProject[p.id]?.length ?? 0;
            const status = p.status?.value ?? 'not_started';
            return (
              <div
                key={p.id}
                className="design-card"
              >
                <button
                  type="button"
                  className="design-card-hit-target"
                  title={p.name}
                  aria-label={p.name}
                  onClick={() => onOpen(p.id)}
                />
                <button
                  type="button"
                  className="design-card-close"
                  title={t('designs.deleteTitle')}
                  aria-label={t('designs.deleteAria', { name: p.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(t('designs.deleteConfirm', { name: p.name }))) onDelete(p.id);
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
                <div className="design-card-thumb" aria-hidden>
                  <CoreArtifactPreview project={p} />
                  {liveCount > 0 ? <span className="design-live-count">{t('designs.liveCount', { n: liveCount })}</span> : null}
                </div>
                <div className="design-card-meta-block">
                  <div className="design-card-name" title={p.name}>{p.name}</div>
                  <div className="design-card-meta">
                    <span className={`design-card-status design-card-status-${status}`}>{statusLabel(status, t)}</span>
                    {p.status?.updatedAt ? ` · ${relativeTime(p.status.updatedAt, t)}` : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="design-kanban-board">
          {STATUS_ORDER.map((status) => {
            const colProjects = filteredProjects.filter((item) => normalizeStatus(item.project.status?.value ?? 'not_started') === status);
            return (
              <div key={status} className="design-kanban-col">
                <div className="design-kanban-header">
                  <span>{statusLabel(status, t)}</span>
                  <span className="design-kanban-count">{colProjects.length}</span>
                </div>
                <div className="design-kanban-list">
                  {colProjects.length === 0 ? (
                    <div className="design-kanban-empty">{t('designs.kanbanEmptyColumn')}</div>
                  ) : (
                    colProjects.map(({ project: p }) => {
                      return (
                        <div
                          key={p.id}
                          className={`design-kanban-card status-${status}`}
                        >
                          <button
                            type="button"
                            className="design-kanban-card-hit-target"
                            title={p.name}
                            aria-label={p.name}
                            onClick={() => onOpen(p.id)}
                          />
                          <button
                            type="button"
                            className="design-card-close"
                            title={t('designs.deleteTitle')}
                            aria-label={t('designs.deleteAria', { name: p.name })}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(t('designs.deleteConfirm', { name: p.name }))) onDelete(p.id);
                            }}
                          >
                            <Icon name="close" size={12} />
                          </button>
                          <div className="design-kanban-card-name" title={p.name}>{p.name}</div>
                          {p.status?.updatedAt ? (
                            <div className="design-kanban-card-meta">
                              {relativeTime(p.status.updatedAt, t)}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function coreArtifactPathForProject(project: Project): string | null {
  if (project.metadata?.kind !== 'deck') return null;
  const slideWorkspace = project.metadata.slideWorkspace || 'slides';
  const slideId = project.metadata.slideId || 'main-deck';
  return `${slideWorkspace.replace(/\/+$/g, '')}/${slideId}/index.tsx`;
}

export function sortDesignListItemsForDisplay(
  items: DesignListItem[],
  sortMode: DesignSortMode = DEFAULT_DESIGN_SORT_MODE,
): DesignListItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const primary = compareDesignListItems(a.item, b.item, sortMode);
      return primary || a.index - b.index;
    })
    .map(({ item }) => item);
}

function compareDesignListItems(a: DesignListItem, b: DesignListItem, sortMode: DesignSortMode): number {
  switch (sortMode) {
    case 'created-desc':
      return compareNumber(designItemCreatedAt(b), designItemCreatedAt(a)) || compareDesignListItemsFallback(a, b);
    case 'created-asc':
      return compareNumber(designItemCreatedAt(a), designItemCreatedAt(b)) || compareDesignListItemsFallback(a, b);
    case 'updated-desc':
      return compareNumber(designItemUpdatedAt(b), designItemUpdatedAt(a)) || compareDesignListItemsFallback(a, b);
    case 'name-asc':
      return compareDesignItemName(a, b) || compareDesignListItemsFallback(a, b);
    case 'name-desc':
      return compareDesignItemName(b, a) || compareDesignListItemsFallback(a, b);
    case 'status':
      return compareNumber(designItemStatusRank(a), designItemStatusRank(b)) || compareDesignListItemsFallback(a, b);
  }
  const exhaustive: never = sortMode;
  return exhaustive;
}

function compareDesignListItemsFallback(a: DesignListItem, b: DesignListItem): number {
  return (
    compareNumber(designItemUpdatedAt(b), designItemUpdatedAt(a)) ||
    compareNumber(designItemCreatedAt(b), designItemCreatedAt(a)) ||
    compareDesignItemName(a, b) ||
    designItemId(a).localeCompare(designItemId(b))
  );
}

function compareDesignItemName(a: DesignListItem, b: DesignListItem): number {
  return designItemTitle(a).localeCompare(designItemTitle(b), undefined, { sensitivity: 'base' });
}

function compareNumber(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function designItemCreatedAt(item: DesignListItem): number {
  if (item.type === 'project') return item.project.createdAt;
  return parseLiveArtifactTimestamp(item.liveArtifact.createdAt, item.project.createdAt);
}

function designItemUpdatedAt(item: DesignListItem): number {
  return item.updatedAt;
}

function designItemTitle(item: DesignListItem): string {
  return item.type === 'project' ? item.project.name : item.liveArtifact.title;
}

function designItemId(item: DesignListItem): string {
  return item.type === 'project' ? `project:${item.project.id}` : `live:${item.liveArtifact.id}`;
}

function designItemStatusRank(item: DesignListItem): number {
  if (item.type === 'live-artifact') {
    if (item.liveArtifact.refreshStatus === 'running') return STATUS_ORDER.indexOf('running');
    if (item.liveArtifact.status === 'error') return STATUS_ORDER.indexOf('failed');
    if (item.liveArtifact.status === 'archived') return STATUS_ORDER.indexOf('canceled');
    return STATUS_ORDER.indexOf('succeeded');
  }
  return STATUS_ORDER.indexOf(normalizeStatus(item.project.status?.value ?? 'not_started'));
}

function parseLiveArtifactTimestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function CoreArtifactPreview({ project }: { project: Project }) {
  const coreArtifactPath = coreArtifactPathForProject(project);
  const slideId = project.metadata?.slideId || 'main-deck';
  const [moduleCode, setModuleCode] = useState<string | null>(null);
  const [resolvedSlideId, setResolvedSlideId] = useState(slideId);
  const [design, setDesign] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    if (!coreArtifactPath) return;
    let cancelled = false;
    setModuleCode(null);
    setResolvedSlideId(slideId);
    setDesign(null);
    void Promise.all([
      fetchOpenSlideModule(project.id, slideId),
      fetchOpenSlideDesign(project.id, slideId),
    ]).then(([moduleResult, designResult]) => {
      if (cancelled) return;
      setResolvedSlideId(moduleResult?.slideId || slideId);
      setModuleCode(moduleResult?.code ?? null);
      setDesign((designResult?.design as Record<string, any>) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [coreArtifactPath, project.id, project.updatedAt, slideId]);

  const runtime = useMemo(
    () => (moduleCode ? evaluateOpenSlideRuntime(moduleCode, project.id, resolvedSlideId) : null),
    [moduleCode, project.id, resolvedSlideId],
  );
  const Page = runtime?.pages[0] ?? null;
  const runtimeDesign = design ?? runtime?.design ?? null;
  if (!Page) return null;

  return (
    <div className="design-card-core-preview" data-core-artifact={coreArtifactPath}>
      <OpenSlideCanvas
        design={runtimeDesign}
        flat
        freezeMotion
        className="design-card-core-preview-canvas"
      >
        <OpenSlideRuntimePageView page={Page} design={runtimeDesign} />
      </OpenSlideCanvas>
    </div>
  );
}

function normalizeStatus(status: ProjectDisplayStatus): Exclude<ProjectDisplayStatus, 'queued'> {
  return status === 'queued' ? 'running' : status;
}

function statusLabel(status: ProjectDisplayStatus, t: ReturnType<typeof useT>): string {
  return t(STATUS_LABEL_KEYS[status]);
}

function relativeTime(ts: number, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return t('common.justNow');
  if (diff < hr) return t('common.minutesAgo', { n: Math.floor(diff / min) });
  if (diff < day) return t('common.hoursAgo', { n: Math.floor(diff / hr) });
  if (diff < 7 * day) return t('common.daysAgo', { n: Math.floor(diff / day) });
  return new Date(ts).toLocaleDateString();
}

function artifactStatusLabel(
  status: LiveArtifactSummary['status'],
  refreshStatus: LiveArtifactSummary['refreshStatus'],
  t: ReturnType<typeof useT>,
): string {
  if (status === 'archived') return t('designs.statusArchived');
  if (status === 'error') return t('designs.statusError');
  if (refreshStatus === 'running') return t('designs.statusRefreshing');
  if (refreshStatus === 'failed') return t('designs.statusRefreshFailed');
  if (refreshStatus === 'succeeded') return t('designs.statusRefreshed');
  return t('designs.statusLive');
}
