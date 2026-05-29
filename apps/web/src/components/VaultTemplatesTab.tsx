import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  createVaultIngestion,
  deleteVaultDesign,
  fetchVaultDesigns,
  fetchVaultDiscovery,
  fetchVaultJob,
  fetchVaultStatus,
  syncVaultDesignSystems,
  type VaultDiscoveryInfo,
} from '../providers/registry';
import type { VaultDesignMeta, VaultIngestionJob, VaultSyncResponse } from '../types';
import { useT } from '../i18n';
import { buildVaultDeepLinkUrl } from '../utils/vaultDeepLink';
import { vaultTemplateCoverPreviewSource } from '../utils/vaultPreview';
import { DesignVaultInstallGate } from './DesignVaultInstallGate';
import { Icon } from './Icon';
import { CenteredLoader } from './Loading';
import { VaultPreviewFrame } from './VaultPreviewFrame';

type VaultSourceFilter = 'all' | VaultDesignMeta['sourceMode'];
type VaultFavoriteFilter = 'all' | 'favorites';
type VaultViewMode = 'grid' | 'list';
type VaultSortKey = 'quality' | 'updated' | 'created' | 'title' | 'source' | 'category';
type VaultSortDirection = 'asc' | 'desc';

interface VaultFilterOption<T extends string = string> {
  value: T;
  label: string;
  count: number;
}

export function VaultTemplatesTab() {
  const t = useT();
  const [designs, setDesigns] = useState<VaultDesignMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<VaultSourceFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [favoriteFilter, setFavoriteFilter] = useState<VaultFavoriteFilter>('all');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [sortKey, setSortKey] = useState<VaultSortKey>('updated');
  const [sortDirection, setSortDirection] = useState<VaultSortDirection>('desc');
  const [viewMode, setViewMode] = useState<VaultViewMode>('grid');
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'url' | 'clone-website'>('url');
  const [job, setJob] = useState<VaultIngestionJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ingestionAvailable, setIngestionAvailable] = useState(true);
  const [designsRoot, setDesignsRoot] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<VaultSyncResponse | null>(null);
  const [syncError, setSyncError] = useState('');
  const [deletingSlug, setDeletingSlug] = useState('');
  const [deleteMessage, setDeleteMessage] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [discovery, setDiscovery] = useState<VaultDiscoveryInfo | null>(null);
  const [installGateOpen, setInstallGateOpen] = useState(false);
  const [importedToast, setImportedToast] = useState<{ slug: string; title?: string } | null>(null);
  const importToastTimerRef = useRef<number | null>(null);
  const sortOptions = useMemo<Array<{ value: VaultSortKey; label: string }>>(() => [
    { value: 'updated', label: t('vault.sort.updated') },
    { value: 'quality', label: t('vault.sort.quality') },
    { value: 'created', label: t('vault.sort.created') },
    { value: 'title', label: t('vault.sort.title') },
    { value: 'source', label: t('vault.sort.source') },
    { value: 'category', label: t('vault.sort.category') },
  ], [t]);

  const launchDeepLink = useCallback((baseUrl: string | null) => {
    const target = buildVaultDeepLinkUrl(baseUrl, window.location.href);
    window.location.href = target;
  }, []);

  async function reload() {
    setLoading(true);
    try {
      const [nextDesigns, status] = await Promise.all([
        fetchVaultDesigns(),
        fetchVaultStatus(),
      ]);
      setDesigns(nextDesigns);
      setIngestionAvailable(status?.ingestionAvailable ?? false);
      setDesignsRoot(status?.designsRoot ?? '');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    const id = window.setInterval(async () => {
      const next = await fetchVaultJob(job.id);
      if (!next) return;
      setJob(next);
      if (next.status === 'completed') void reload();
    }, 1800);
    return () => window.clearInterval(id);
  }, [job]);

  // Initial discovery probe + lightweight refresh.
  useEffect(() => {
    let cancelled = false;
    void fetchVaultDiscovery().then((next) => {
      if (cancelled) return;
      setDiscovery(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Handle ?imported=<slug>&from=design-vault return from a deep-link round trip.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const imported = params.get('imported');
    const from = params.get('from');
    if (!imported || from !== 'design-vault') return;

    // Strip the query params first so a refresh doesn't re-trigger this branch.
    const clean = new URL(window.location.href);
    clean.searchParams.delete('imported');
    clean.searchParams.delete('from');
    window.history.replaceState({}, '', clean.toString());

    // Best-effort sync; surface failures only via setSyncError to avoid breaking flow.
    void (async () => {
      try {
        const result = await syncVaultDesignSystems();
        setSyncResult(result);
      } catch (error) {
        setSyncError(error instanceof Error ? `同步失败：${error.message}` : '同步失败：SFA daemon 没有返回可用结果。');
      }
      const nextDesigns = await fetchVaultDesigns();
      setDesigns(nextDesigns);
      const found = nextDesigns.find((design) => design.slug === imported);
      setImportedToast({ slug: imported, title: found?.title });
      if (importToastTimerRef.current) window.clearTimeout(importToastTimerRef.current);
      importToastTimerRef.current = window.setTimeout(() => setImportedToast(null), 6000);
    })();
  }, []);

  useEffect(() => {
    return () => {
      if (importToastTimerRef.current) window.clearTimeout(importToastTimerRef.current);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return designs.filter((design) => {
      if (sourceFilter !== 'all' && design.sourceMode !== sourceFilter) return false;
      if (categoryFilter !== 'all' && vaultCategoryValue(design) !== categoryFilter) return false;
      if (tagFilter !== 'all' && !(design.tags ?? []).includes(tagFilter)) return false;
      if (favoriteFilter === 'favorites' && !design.favorite) return false;
      if (!q) return true;
      const tags = design.tags?.join(' ') ?? '';
      return (
        design.title.toLowerCase().includes(q) ||
        design.sourceHost.toLowerCase().includes(q) ||
        design.summary.toLowerCase().includes(q) ||
        (design.profile?.archetype ?? '').toLowerCase().includes(q) ||
        tags.toLowerCase().includes(q)
      );
    });
  }, [categoryFilter, designs, favoriteFilter, filter, sourceFilter, tagFilter]);

  const sortedDesigns = useMemo(() => {
    return filtered
      .map((design, index) => ({ design, index }))
      .sort((a, b) => {
        const primary = compareVaultDesigns(a.design, b.design, sortKey);
        if (primary !== 0) return sortDirection === 'asc' ? primary : -primary;
        return vaultTitleCompare(a.design, b.design) || a.index - b.index;
      })
      .map((item) => item.design);
  }, [filtered, sortDirection, sortKey]);

  const sourceOptions = useMemo<VaultFilterOption<VaultSourceFilter>[]>(() => {
    const counts = new Map<VaultDesignMeta['sourceMode'], number>();
    for (const design of designs) {
      counts.set(design.sourceMode, (counts.get(design.sourceMode) ?? 0) + 1);
    }
    const values: VaultDesignMeta['sourceMode'][] = ['url', 'clone-website', 'design-system-project'];
    return [
      { value: 'all', label: '全部', count: designs.length },
      ...values
        .filter((value) => counts.has(value))
        .map((value) => ({ value, label: vaultSourceLabel(value), count: counts.get(value) ?? 0 })),
    ];
  }, [designs]);

  const categoryOptions = useMemo<VaultFilterOption[]>(() => {
    return [
      { value: 'all', label: '全部', count: designs.length },
      ...countedOptions(designs.map(vaultCategoryValue), 7).map((option) => ({
        ...option,
        label: vaultDisplayLabel(option.value),
      })),
    ];
  }, [designs]);

  const tagOptions = useMemo<VaultFilterOption[]>(() => {
    const tags = designs.flatMap((design) => design.tags ?? []);
    return [
      { value: 'all', label: '全部', count: designs.length },
      ...countedOptions(tags, 10).map((option) => ({
        ...option,
        label: vaultDisplayLabel(option.value),
      })),
    ];
  }, [designs]);

  const favoriteOptions = useMemo<VaultFilterOption<VaultFavoriteFilter>[]>(() => {
    const favoriteCount = designs.filter((design) => design.favorite).length;
    return [
      { value: 'all', label: t('vault.filter.all'), count: designs.length },
      { value: 'favorites', label: t('vault.filter.favorites'), count: favoriteCount },
    ];
  }, [designs, t]);

  async function submitIngestion() {
    if (!url.trim() || submitting) return;
    setSubmitting(true);
    try {
      const next = await createVaultIngestion({ url: url.trim(), mode });
      if (next) {
        setJob(next);
        setUrl('');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleIngestSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitIngestion();
  }

  async function syncCatalog() {
    if (syncing) return;
    setSyncing(true);
    setSyncError('');
    try {
      const result = await syncVaultDesignSystems();
      setSyncResult(result);
      await reload();
    } catch (error) {
      setSyncError(error instanceof Error ? `同步失败：${error.message}` : '同步失败：SFA daemon 没有返回可用结果。');
    } finally {
      setSyncing(false);
    }
  }

  function handleSortChange(nextKey: VaultSortKey) {
    setSortKey(nextKey);
    setSortDirection(defaultVaultSortDirection(nextKey));
  }

  async function deleteTemplate(design: VaultDesignMeta) {
    if (deletingSlug) return;
    const confirmed = window.confirm(`删除模板「${design.title}」？`);
    if (!confirmed) return;
    setDeletingSlug(design.slug);
    setDeleteError('');
    setDeleteMessage('');
    try {
      await deleteVaultDesign(design.slug);
      setDesigns((items) => items.filter((item) => item.slug !== design.slug));
      setSyncResult(null);
      setDeleteMessage(`已删除模板：${design.title}`);
    } catch (error) {
      setDeleteError(error instanceof Error ? `删除失败：${error.message}` : '删除失败：SFA daemon 没有返回可用结果。');
    } finally {
      setDeletingSlug('');
    }
  }

  const syncTargetCount = syncResult?.total ?? designs.length;
  const syncedAll = syncResult ? syncResult.failed === 0 && syncResult.synced === syncResult.total : false;
  const filterActive =
    filter.trim().length > 0 ||
    sourceFilter !== 'all' ||
    categoryFilter !== 'all' ||
    tagFilter !== 'all' ||
    favoriteFilter !== 'all';
  const activeFilterCount =
    (filter.trim().length > 0 ? 1 : 0) +
    (sourceFilter !== 'all' ? 1 : 0) +
    (categoryFilter !== 'all' ? 1 : 0) +
    (tagFilter !== 'all' ? 1 : 0) +
    (favoriteFilter !== 'all' ? 1 : 0);
  const catalogCountLabel = loading
    ? '正在加载'
    : filterActive
      ? `${filtered.length} / ${designs.length}`
      : `${designs.length} 条资料`;

  return (
    <div className="tab-panel vault-panel">
      <div className="vault-library-header">
        <div className="vault-heading">
          <span className="vault-kicker">Design Vault</span>
          <h2>
            设计资料库
            <span>{loading ? '...' : `${designs.length} 条`}</span>
          </h2>
        </div>
        <div className="vault-header-actions">
          <div className="vault-view-switch" role="group" aria-label="切换资料库视图">
            <button
              type="button"
              className={viewMode === 'grid' ? 'active' : ''}
              aria-pressed={viewMode === 'grid'}
              title="网格视图"
              onClick={() => setViewMode('grid')}
            >
              <Icon name="grid" size={15} />
            </button>
            <button
              type="button"
              className={viewMode === 'list' ? 'active' : ''}
              aria-pressed={viewMode === 'list'}
              title="列表视图"
              onClick={() => setViewMode('list')}
            >
              <Icon name="layout" size={15} />
            </button>
          </div>
          <button
            className="primary vault-sync-button"
            type="button"
            onClick={() => {
              if (discovery && discovery.state === 'running') {
                launchDeepLink(discovery.baseUrl);
              } else {
                setInstallGateOpen(true);
              }
            }}
            title="在 Design Vault 中新增模板（完成后自动返回）"
          >
            <Icon name="external-link" size={13} />
            <span>在 Design Vault 新增模板</span>
          </button>
          <button className="primary vault-sync-button" type="button" disabled={syncing} onClick={syncCatalog}>
            {syncing ? <Icon name="spinner" size={13} /> : <Icon name="refresh" size={13} />}
            <span>{syncing ? `同步中 ${syncTargetCount || ''}`.trim() : '同步资料库'}</span>
          </button>
        </div>
      </div>

      {importedToast ? (
        <div
          role="status"
          className="vault-imported-toast"
          style={{
            margin: '0 0 12px',
            padding: '10px 14px',
            background: 'var(--surface-muted, #1d1d1d)',
            border: '1px solid var(--accent, #6c5ce7)',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
          }}
        >
          <Icon name="check" size={14} />
          <span>
            已从 Design Vault 导入 <strong>{importedToast.title || importedToast.slug}</strong>，资料库已刷新。
          </span>
          <button
            type="button"
            className="ghost"
            style={{ marginLeft: 'auto' }}
            onClick={() => setImportedToast(null)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : null}

      {installGateOpen ? (
        <DesignVaultInstallGate
          onClose={() => setInstallGateOpen(false)}
          onReady={(info) => {
            setDiscovery(info);
            setInstallGateOpen(false);
            launchDeepLink(info.baseUrl);
          }}
        />
      ) : null}

      <div className="vault-command-bar">
        <label className="vault-search">
          <span className="search-icon" aria-hidden>
            <Icon name="search" size={14} />
          </span>
          <input
            type="search"
            placeholder="搜索标题、域名、摘要、标签"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <div className="vault-sort-controls">
          <select
            className="vault-sort-select"
            value={sortKey}
            aria-label={t('vault.sort.aria')}
            onChange={(event) => handleSortChange(event.target.value as VaultSortKey)}
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`vault-sort-direction ${sortDirection}`}
            aria-label={sortDirection === 'asc' ? t('vault.sort.asc') : t('vault.sort.desc')}
            title={sortDirection === 'asc' ? t('vault.sort.asc') : t('vault.sort.desc')}
            onClick={() => setSortDirection((value) => (value === 'asc' ? 'desc' : 'asc'))}
          >
            <Icon name="arrow-up" size={13} />
            <span>{sortDirection === 'asc' ? t('vault.sort.asc') : t('vault.sort.desc')}</span>
          </button>
        </div>
        <div className="vault-command-meta">
          <span>{catalogCountLabel}</span>
          {designsRoot ? <em title={designsRoot}>{designsRoot}</em> : null}
        </div>
      </div>

      <div className="vault-status-strip">
        <span className={`vault-status-dot ${ingestionAvailable ? 'ready' : 'embedded'}`} aria-hidden />
        <strong>{ingestionAvailable ? '服务已连接' : '内置目录'}</strong>
        <span>{ingestionAvailable ? '支持导入新来源' : '使用项目内置 catalog'}</span>
        <button
          type="button"
          className={`vault-filter-toggle${filtersExpanded ? ' active' : ''}`}
          aria-expanded={filtersExpanded}
          onClick={() => setFiltersExpanded((value) => !value)}
        >
          <Icon name="sliders" size={12} />
          <span>{filtersExpanded ? '收起筛选' : activeFilterCount > 0 ? `筛选 ${activeFilterCount}` : '筛选'}</span>
          <Icon name="chevron-down" size={12} />
        </button>
        {filterActive ? (
          <button
            type="button"
            className="vault-clear-filters"
            onClick={() => {
              setFilter('');
              setSourceFilter('all');
              setCategoryFilter('all');
              setTagFilter('all');
              setFavoriteFilter('all');
            }}
          >
            清除筛选
          </button>
        ) : null}
      </div>
      {filtersExpanded ? (
        <div className="vault-filter-stack">
          <VaultFilterRow
            label={t('vault.filter.source')}
            options={sourceOptions}
            value={sourceFilter}
            onChange={setSourceFilter}
          />
          <VaultFilterRow
            label={t('vault.filter.category')}
            options={categoryOptions}
            value={categoryFilter}
            onChange={setCategoryFilter}
          />
          <VaultFilterRow
            label={t('vault.filter.marker')}
            options={favoriteOptions}
            value={favoriteFilter}
            onChange={setFavoriteFilter}
          />
          {tagOptions.length > 1 ? (
            <VaultFilterRow
              label={t('vault.filter.tags')}
              options={tagOptions}
              value={tagFilter}
              onChange={setTagFilter}
            />
          ) : null}
        </div>
      ) : null}
      {ingestionAvailable ? (
        <form className="vault-ingest-row" onSubmit={handleIngestSubmit}>
          <span className="vault-ingest-label">导入</span>
          <input
            className="vault-ingest-input"
            type="url"
            placeholder="https://example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <select
            value={mode}
            aria-label="导入模式"
            onChange={(event) => setMode(event.target.value as 'url' | 'clone-website')}
          >
            <option value="url">直接网址</option>
            <option value="clone-website">Clone website</option>
          </select>
          <button className="primary" type="submit" disabled={!url.trim() || submitting}>
            {submitting ? <Icon name="spinner" size={13} /> : <Icon name="plus" size={13} />}
            <span>开始导入</span>
          </button>
        </form>
      ) : null}
      {job ? (
        <div className={`vault-job status-${job.status}`}>
          <span>{job.id}</span>
          <strong>{job.status}</strong>
          {job.slug ? <span>{job.slug}</span> : null}
          {job.error ? <span>{job.error}</span> : null}
        </div>
      ) : null}
      {syncError ? (
        <div className="vault-sync-result status-failed">{syncError}</div>
      ) : syncResult ? (
        <div className={`vault-sync-result ${syncResult.failed > 0 ? 'status-warning' : 'status-ready'}`}>
          {syncResult.downloadNeeded ? (
            <span>本地资料库为空；不会从本机其他项目自动导入。请先在 Design Vault 中安装或新增模板。</span>
          ) : (
            <span>
              {syncedAll ? 'All templates synced' : 'Sync completed'}: {syncResult.synced}/{syncResult.total} templates · imported {syncResult.imported} · refreshed {syncResult.refreshed} · skipped {syncResult.skippedImports} source folders · {syncResult.skillPackages} skill packages · {syncResult.promptContexts} prompt contexts
            </span>
          )}
          {syncResult.importSourceRoot ? <small>Source: {syncResult.importSourceRoot}</small> : null}
          {syncResult.errors.length > 0 ? <small>{syncResult.errors.slice(0, 2).join(' · ')}</small> : null}
        </div>
      ) : null}
      {deleteError ? (
        <div className="vault-sync-result status-failed">{deleteError}</div>
      ) : deleteMessage ? (
        <div className="vault-sync-result status-ready">{deleteMessage}</div>
      ) : null}

      {loading ? (
        <CenteredLoader label="Loading Design Vault templates" />
      ) : sortedDesigns.length === 0 ? (
        <div className="tab-empty">No Vault templates found.</div>
      ) : (
        <div className={`ds-grid vault-grid vault-grid-${viewMode}`}>
          {sortedDesigns.map((design) => {
            const preview = vaultTemplateCoverPreviewSource(design);
            const category = vaultCategoryValue(design);
            return (
              <article key={design.slug} className="ds-card vault-card">
                <div className="ds-thumb vault-thumb">
                  {preview?.kind === 'image' ? (
                    <img src={preview.src} alt="" loading="lazy" />
                  ) : preview?.kind === 'frame' ? (
                    <VaultPreviewFrame
                      src={preview.src}
                      title={preview.title}
                      width={preview.width}
                      height={preview.height}
                      sandbox=""
                    />
                  ) : null}
                </div>
                <div className="ds-card-meta">
                  <div className="vault-card-topline">
                    <span>{vaultSourceLabel(design.sourceMode)}</span>
                    <span>{vaultDisplayLabel(category)}</span>
                  </div>
                  <div className="ds-card-title-row">
                    <div className="ds-card-title">{design.title}</div>
                  </div>
                  <div className="ds-card-category">{design.sourceHost}</div>
                  <p>{design.summary}</p>
                  {design.tags && design.tags.length > 0 ? (
                    <div className="vault-card-tags" aria-label="标签">
                      {design.tags.slice(0, 3).map((tag) => (
                        <span key={tag}>{vaultDisplayLabel(tag)}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="ds-card-actions">
                    <a
                      className="ghost vault-card-preview-link"
                      href={`/api/vault/designs/${encodeURIComponent(design.slug)}/preview?kind=ppt`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="external-link" size={12} />
                      <span>PPT 预览</span>
                    </a>
                    <button
                      type="button"
                      className="ghost vault-card-delete-button"
                      title={`删除 ${design.title}`}
                      disabled={deletingSlug === design.slug}
                      onClick={() => void deleteTemplate(design)}
                    >
                      {deletingSlug === design.slug ? <Icon name="spinner" size={12} /> : <Icon name="trash" size={12} />}
                      <span>删除</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VaultFilterRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: VaultFilterOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="vault-filter-row">
      <span className="vault-filter-label">{label}</span>
      <div className="vault-filter-options">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? 'active' : ''}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            <em>{option.count}</em>
          </button>
        ))}
      </div>
    </div>
  );
}

function countedOptions(values: string[], limit: number): VaultFilterOption[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, label: value, count }));
}

function vaultSourceLabel(mode: VaultDesignMeta['sourceMode']): string {
  switch (mode) {
    case 'clone-website':
      return 'Clone';
    case 'design-system-project':
      return '项目';
    case 'url':
    default:
      return 'URL';
  }
}

function vaultCategoryValue(design: VaultDesignMeta): string {
  return (
    design.profile?.archetype?.trim() ||
    design.packageType?.trim() ||
    vaultKindLabel(design.kind)
  );
}

function defaultVaultSortDirection(key: VaultSortKey): VaultSortDirection {
  return key === 'title' || key === 'source' || key === 'category' ? 'asc' : 'desc';
}

function compareVaultDesigns(a: VaultDesignMeta, b: VaultDesignMeta, key: VaultSortKey): number {
  switch (key) {
    case 'quality':
      return vaultQualityScore(a) - vaultQualityScore(b);
    case 'updated':
      return vaultTimestamp(a.updatedAt) - vaultTimestamp(b.updatedAt);
    case 'created':
      return vaultTimestamp(a.createdAt) - vaultTimestamp(b.createdAt);
    case 'source':
      return vaultTextCompare(a.sourceHost, b.sourceHost);
    case 'category':
      return vaultTextCompare(vaultDisplayLabel(vaultCategoryValue(a)), vaultDisplayLabel(vaultCategoryValue(b)));
    case 'title':
    default:
      return vaultTitleCompare(a, b);
  }
}

function vaultTitleCompare(a: VaultDesignMeta, b: VaultDesignMeta): number {
  return vaultTextCompare(a.title, b.title) || vaultTextCompare(a.slug, b.slug);
}

function vaultTextCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function vaultTimestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function vaultQualityScore(design: VaultDesignMeta): number {
  const profile = design.profile as (VaultDesignMeta['profile'] & { qualityScore?: unknown }) | undefined;
  const directScore = (design as VaultDesignMeta & { qualityScore?: unknown }).qualityScore;
  const raw = profile?.qualityScore ?? directScore;
  const score = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(score) ? score : 0;
}

function vaultKindLabel(kind: VaultDesignMeta['kind']): string {
  switch (kind) {
    case 'skill-package':
      return 'Skill 包';
    case 'prompt-context':
      return '提示上下文';
    default:
      return '设计系统';
  }
}

const VAULT_LABEL_OVERRIDES: Record<string, string> = {
  'arts-institution-editorial': '艺术机构编辑风',
  canva: 'Canva',
  'canva-template-preview': 'Canva 预览',
  'canva-template-presentation': 'Canva 演示模板',
  'campaign-editorial presentation system': 'Campaign 编辑系统',
  'component design system': '组件系统',
  'magazine-layout': '杂志版式',
  'pdf-pptx-export-reference': '导出参考',
  'presentation design system': '演示设计系统',
  'presentation-template': '演示模板',
  'source-derived interactive v': '交互视觉',
  'source-derived interactive visual system': '交互视觉系统',
  'source-derived web style sys': '网站风格',
  'source-derived web style system': '网站风格系统',
  'url 导入': 'URL 导入',
};

function vaultDisplayLabel(value: string): string {
  const raw = value.trim();
  const mapped = VAULT_LABEL_OVERRIDES[raw.toLowerCase()];
  if (mapped) return mapped;
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\burl\b/gi, 'URL')
    .replace(/\bpptx\b/gi, 'PPTX')
    .replace(/\bpdf\b/gi, 'PDF');
}
