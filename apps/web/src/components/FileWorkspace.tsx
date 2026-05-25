import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import {
  applyOpenSlideEdits,
  type OpenSlideBatchEdit,
  type OpenSlideEditOp,
  createSlideFeedback,
  deleteProjectFile,
  fetchOpenSlideDesign,
  fetchOpenSlideModule,
  fetchOpenSlideSource,
  fetchProjectFileText,
  projectRawUrl,
  updateOpenSlideDesign,
  uploadProjectFiles,
  writeProjectTextFile,
} from '../providers/registry';
import {
  liveArtifactSummaryToWorkspaceEntry,
  type LiveArtifactSummary,
  type LiveArtifactEventItem,
  type LiveArtifactWorkspaceEntry,
  type OpenTabsState,
  type PreviewComment,
  type PreviewCommentTarget,
  type ProjectFile,
  type ChatSlideFeedbackAttachment,
  type SlideFeedback,
} from '../types';
import { DesignFilesPanel } from './DesignFilesPanel';
import { FileViewer, LiveArtifactViewer } from './FileViewer';
import { Icon } from './Icon';
import { LiveArtifactBadges } from './LiveArtifactBadges';
import { openPptDeckSourceLabel } from './openppt-file-display';
import { PasteTextDialog } from './PasteTextDialog';
import { SketchEditor, type SketchDocument, type SketchItem } from './SketchEditor';

interface Props {
  projectId: string;
  files: ProjectFile[];
  liveArtifacts: LiveArtifactSummary[];
  onRefreshFiles: () => Promise<void> | void;
  isDeck: boolean;
  onExportAsPptx?: ((fileName: string) => void) | undefined;
  streaming?: boolean;
  openRequest?: { name: string; nonce: number } | null;
  liveArtifactEvents?: LiveArtifactEventItem[];
  // Persisted set of open tabs + active tab. Owned by ProjectView so the
  // daemon's SQLite store can hold the source of truth and survive reloads.
  tabsState: OpenTabsState;
  onTabsStateChange: (next: OpenTabsState) => void;
  previewComments?: PreviewComment[];
  slideFeedback?: SlideFeedback[];
  activeConversationId?: string | null;
  onSavePreviewComment?: (target: PreviewCommentTarget, note: string, attachAfterSave: boolean) => Promise<PreviewComment | null>;
  onRemovePreviewComment?: (commentId: string) => Promise<void>;
  onRefreshSlideFeedback?: () => Promise<void> | void;
  onApplySlideFeedback?: (prompt: string, attachments?: ChatSlideFeedbackAttachment[]) => void;
  onOpenSlideInspectActiveChange?: (active: boolean) => void;
}

interface SketchState {
  items: SketchItem[];
  dirty: boolean;
  persisted: boolean;
  loaded: boolean;
  saving: boolean;
}

const DESIGN_FILES_TAB = '__design_files__';
type OpenSlideExportKind = 'assets' | 'pptx' | 'pptx-raster';

function openSlideExportEndpoint(
  projectId: string,
  slideId: string,
  kind: OpenSlideExportKind,
): string {
  const params = new URLSearchParams({ slideId });
  if (kind === 'pptx-raster') params.set('strategy', 'raster');
  const target = kind === 'assets' ? 'assets' : 'pptx';
  return `/api/projects/${encodeURIComponent(projectId)}/open-slide/export/${target}?${params.toString()}`;
}

function openSlideExportFallbackFilename(kind: OpenSlideExportKind): string {
  if (kind === 'assets') return 'sfa-deck-html-pdf-assets.zip';
  if (kind === 'pptx-raster') return 'sfa-deck-raster.pptx';
  return 'sfa-deck.pptx';
}

function filenameFromDisposition(resp: Response, fallback: string): string {
  const header = resp.headers.get('content-disposition') || '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // Fall through to the quoted filename fallback.
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? fallback;
}

function parseDownloadFailure(body: string, fallback: string): string {
  if (!body.trim()) return fallback;
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string | { message?: string } };
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
    if (
      parsed.error &&
      typeof parsed.error === 'object' &&
      typeof parsed.error.message === 'string' &&
      parsed.error.message.trim()
    ) {
      return parsed.error.message;
    }
  } catch {
    // Plain-text API errors are still useful as-is.
  }
  return body;
}

function triggerOpenSlideDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadOpenSlideExport(
  projectId: string,
  slideId: string,
  kind: OpenSlideExportKind,
): Promise<void> {
  const resp = await fetch(openSlideExportEndpoint(projectId, slideId, kind), { cache: 'no-store' });
  if (!resp.ok) {
    const fallback = `${resp.status} ${resp.statusText}`.trim() || 'Export request failed';
    const body = await resp.text().catch(() => '');
    throw new Error(parseDownloadFailure(body, fallback));
  }
  const blob = await resp.blob();
  triggerOpenSlideDownload(blob, filenameFromDisposition(resp, openSlideExportFallbackFilename(kind)));
}

export function FileWorkspace({
  projectId,
  files,
  liveArtifacts,
  onRefreshFiles,
  isDeck,
  onExportAsPptx,
  streaming,
  openRequest,
  liveArtifactEvents = [],
  tabsState,
  onTabsStateChange,
  previewComments = [],
  slideFeedback = [],
  activeConversationId = null,
  onSavePreviewComment,
  onRemovePreviewComment,
  onRefreshSlideFeedback,
  onApplySlideFeedback,
  onOpenSlideInspectActiveChange,
}: Props) {
  const t = useT();
  // Persisted tabs come from the parent. Active tab can transiently point
  // at a pending sketch — pending sketches are not in tabsState.tabs.
  const persistedTabs = tabsState.tabs;
  const [activeTab, setActiveTab] = useState<string>(
    tabsState.active ?? DESIGN_FILES_TAB,
  );

  const [showPasteDialog, setShowPasteDialog] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sketches, setSketches] = useState<Record<string, SketchState>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const visibleFiles = useMemo(
    () => files.filter((file) => !isLiveArtifactImplementationPath(file.name)),
    [files],
  );

  const liveArtifactEntries = useMemo(
    () => liveArtifacts.map(liveArtifactSummaryToWorkspaceEntry),
    [liveArtifacts],
  );

  // Pull the persisted active tab in when the parent's hydration completes
  // (or on project switch). Fall back to the Design Files browser so a
  // fresh project lands in a useful place.
  useEffect(() => {
    setActiveTab(tabsState.active ?? DESIGN_FILES_TAB);
  }, [tabsState.active]);

  function setPersistedActive(name: string | null) {
    setActiveTab(name ?? DESIGN_FILES_TAB);
    onTabsStateChange({ tabs: persistedTabs, active: name });
  }

  function activatePending(name: string) {
    // Pending sketches are not in tabsState.tabs — flip the local
    // activeTab without round-tripping through the parent.
    setActiveTab(name);
  }

  // When the persisted tab list changes and the active tab is gone, fall
  // back to the last remaining tab. Skip transient activeTab values
  // (DESIGN_FILES_TAB, pending sketches) since those aren't in persistedTabs.
  useEffect(() => {
    if (activeTab === DESIGN_FILES_TAB) return;
    if (sketches[activeTab] && !sketches[activeTab]!.persisted) return;
    if (!persistedTabs.includes(activeTab)) {
      setPersistedActive(persistedTabs[persistedTabs.length - 1] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedTabs, activeTab]);

  // External open requests from chat (tool cards, produced-file chips,
  // deep-linked URL, or the parent's auto-open after an agent Write) —
  // add the file to the open-tabs set and focus it.
  useEffect(() => {
    if (!openRequest) return;
    const name = openRequest.name;
    if (!name) return;
    onTabsStateChange({
      tabs: persistedTabs.includes(name) ? persistedTabs : [...persistedTabs, name],
      active: name,
    });
    setActiveTab(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  function openFile(name: string) {
    onTabsStateChange({
      tabs: persistedTabs.includes(name) ? persistedTabs : [...persistedTabs, name],
      active: name,
    });
    setActiveTab(name);
  }

  function closeTab(name: string) {
    const isPending = sketches[name] && !sketches[name]!.persisted;
    if (isPending) {
      setSketches((curr) => {
        const next = { ...curr };
        delete next[name];
        return next;
      });
      if (activeTab === name) {
        setPersistedActive(persistedTabs[persistedTabs.length - 1] ?? null);
      }
      return;
    }
    const nextTabs = persistedTabs.filter((n) => n !== name);
    const nextActive =
      tabsState.active === name
        ? nextTabs[nextTabs.length - 1] ?? null
        : tabsState.active;
    onTabsStateChange({ tabs: nextTabs, active: nextActive });
    setActiveTab(nextActive ?? DESIGN_FILES_TAB);
    setSketches((curr) => {
      const next = { ...curr };
      const entry = next[name];
      if (entry && !entry.persisted) delete next[name];
      return next;
    });
  }

  async function handleFilePicked(ev: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(ev.target.files ?? []);
    ev.target.value = '';
    await uploadFiles(picked);
  }

  async function uploadFiles(picked: File[]) {
    if (picked.length === 0) return;

    setUploadError(null);
    const result = await uploadProjectFiles(projectId, picked);
    if (result.uploaded.length > 0) {
      await onRefreshFiles();
      const lastUploaded = result.uploaded[result.uploaded.length - 1];
      if (lastUploaded?.path) openFile(lastUploaded.path);
    }

    if (result.failed.length > 0) {
      const failedCount = result.failed.length;
      const uploadedCount = result.uploaded.length;
      const detail = result.error ? ` (${result.error})` : '';
      setUploadError(
        uploadedCount > 0
          ? `Uploaded ${uploadedCount} file(s), but ${failedCount} failed${detail}.`
          : `Upload failed for ${failedCount} file(s)${detail}.`,
      );
      console.warn('Project upload had failures', result.failed);
    }
  }

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const isAllowedDropTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      return Boolean(target.closest('.df-drop, .composer'));
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e) || isAllowedDropTarget(e.target)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e) || isAllowedDropTarget(e.target)) return;
      e.preventDefault();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  async function handleDelete(name: string) {
    if (!confirm(t('workspace.deleteFileConfirm', { name }))) return;
    const ok = await deleteProjectFile(projectId, name);
    if (ok) {
      await onRefreshFiles();
      const nextTabs = persistedTabs.filter((n) => n !== name);
      if (activeTab === name) {
        // User is viewing the file being deleted: fall back to another
        // open tab (or the Design Files panel if none remain).
        const nextActive = nextTabs[nextTabs.length - 1] ?? null;
        onTabsStateChange({ tabs: nextTabs, active: nextActive });
        setActiveTab(nextActive ?? DESIGN_FILES_TAB);
      } else {
        // Deletion was triggered from the Design Files panel (or another
        // tab). We preserve `activeTab` because the user is viewing a
        // different context (Design Files or another tab) and shouldn't
        // be navigated away. Only clear the persisted active reference
        // when it points at the deleted file so we don't leave a dangling
        // pointer behind.
        const nextActive = tabsState.active === name ? null : tabsState.active;
        onTabsStateChange({ tabs: nextTabs, active: nextActive });
      }
      setSketches((curr) => {
        const next = { ...curr };
        delete next[name];
        return next;
      });
    }
  }

  function startNewSketch() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `sketch-${stamp}.sketch.json`;
    setSketches((curr) => ({
      ...curr,
      [name]: { items: [], dirty: false, persisted: false, loaded: true, saving: false },
    }));
    activatePending(name);
  }

  // When the active tab is a sketch we don't have items for yet, load from
  // disk. Pending sketches start with loaded=true and skip this path.
  useEffect(() => {
    if (activeTab === DESIGN_FILES_TAB) return;
    if (!isSketchName(activeTab)) return;
    if (sketches[activeTab]?.loaded) return;
    let cancelled = false;
    void fetchProjectFileText(projectId, activeTab).then((text) => {
      if (cancelled) return;
      const items = parseSketchDocument(text);
      setSketches((curr) => ({
        ...curr,
        [activeTab]: {
          items,
          dirty: false,
          persisted: true,
          loaded: true,
          saving: false,
        },
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab, projectId, sketches]);

  function setSketchItems(name: string, items: SketchItem[]) {
    setSketches((curr) => ({
      ...curr,
      [name]: {
        ...(curr[name] ?? { persisted: false, loaded: true, saving: false }),
        items,
        dirty: true,
      } as SketchState,
    }));
  }

  async function saveSketch(name: string) {
    const entry = sketches[name];
    if (!entry) return;
    setSketches((curr) => ({ ...curr, [name]: { ...curr[name]!, saving: true } }));
    const doc: SketchDocument = { version: 1, items: entry.items };
    const file = await writeProjectTextFile(projectId, name, JSON.stringify(doc, null, 2));
    if (file) {
      setSketches((curr) => ({
        ...curr,
        [name]: { ...curr[name]!, dirty: false, persisted: true, saving: false },
      }));
      // Promote the previously-pending sketch into the persisted tab list.
      onTabsStateChange({
        tabs: persistedTabs.includes(name) ? persistedTabs : [...persistedTabs, name],
        active: name,
      });
      setActiveTab(name);
      await onRefreshFiles();
    } else {
      setSketches((curr) => ({ ...curr, [name]: { ...curr[name]!, saving: false } }));
    }
  }

  const activeFile = useMemo<ProjectFile | null>(() => {
    if (activeTab === DESIGN_FILES_TAB) return null;
    const onDisk = visibleFiles.find((f) => f.name === activeTab);
    if (onDisk) return onDisk;
    if (isSketchName(activeTab) && sketches[activeTab]) {
      return {
        name: activeTab,
        size: 0,
        mtime: Date.now(),
        kind: 'sketch',
        mime: 'application/json',
      };
    }
    return null;
  }, [activeTab, visibleFiles, sketches]);

  const activeLiveArtifact = useMemo<LiveArtifactWorkspaceEntry | null>(() => {
    if (activeTab === DESIGN_FILES_TAB) return null;
    return liveArtifactEntries.find((entry) => entry.tabId === activeTab) ?? null;
  }, [activeTab, liveArtifactEntries]);

  // Tabs rendered are persisted tabs plus any pending (un-saved) sketches.
  const tabNames = useMemo(() => {
    const seen = new Set(persistedTabs);
    const extras: string[] = [];
    for (const name of Object.keys(sketches)) {
      if (!sketches[name]?.persisted && !seen.has(name)) {
        extras.push(name);
        seen.add(name);
      }
    }
    return [...persistedTabs, ...extras];
  }, [persistedTabs, sketches]);

  const isActiveSketch = activeFile?.kind === 'sketch' && isSketchName(activeFile.name);
  const activeSketch = activeFile && isActiveSketch ? sketches[activeFile.name] : null;

  return (
    <div className="workspace" data-testid="file-workspace">
      <div className="ws-tabs-bar" role="tablist" aria-label={t('workspace.designFiles')}>
        <button
          type="button"
          className={`ws-tab design-files-tab ${activeTab === DESIGN_FILES_TAB ? 'active' : ''}`}
          role="tab"
          aria-selected={activeTab === DESIGN_FILES_TAB}
          tabIndex={0}
          data-testid="design-files-tab"
          onClick={() => setActiveTab(DESIGN_FILES_TAB)}
          title={t('workspace.designFiles')}
        >
          <span className="tab-icon" aria-hidden>
            <Icon name="grid" size={13} />
          </span>
          <span className="ws-tab-label">{t('workspace.designFiles')}</span>
        </button>
        {tabNames.map((name) => {
          const sketchEntry = sketches[name];
          const dirtyMark =
            sketchEntry && (sketchEntry.dirty || !sketchEntry.persisted) ? ' •' : '';
          const isPending = sketchEntry && !sketchEntry.persisted;
          const onDisk = visibleFiles.find((f) => f.name === name);
          const liveArtifact = liveArtifactEntries.find((entry) => entry.tabId === name);
          const deckSource = isDeck && isOpenPptSlideFile(name);
          const kind = deckSource
            ? 'presentation'
            : liveArtifact ? 'live-artifact' : onDisk?.kind ?? (isSketchName(name) ? 'sketch' : 'text');
          const label = deckSource ? openPptDeckSourceLabel(name, t).title : liveArtifact?.title ?? name;
          return (
            <Tab
              key={name}
              label={`${label}${dirtyMark}`}
              active={activeTab === name}
              onActivate={() =>
                isPending ? activatePending(name) : setPersistedActive(name)
              }
              onClose={() => closeTab(name)}
              kind={kind}
              liveArtifact={liveArtifact}
            />
          );
        })}
      </div>
      <div className="ws-body">
        {uploadError ? <div className="viewer-empty">{uploadError}</div> : null}
        {activeTab === DESIGN_FILES_TAB ? (
          <DesignFilesPanel
            key={projectId}
            projectId={projectId}
            files={visibleFiles}
            liveArtifacts={liveArtifactEntries}
            onRefreshFiles={onRefreshFiles}
            onOpenFile={openFile}
            onOpenLiveArtifact={(tabId) => openFile(tabId)}
            onDeleteFile={(name) => void handleDelete(name)}
            onUpload={() => fileInputRef.current?.click()}
            onUploadFiles={(picked) => void uploadFiles(picked)}
            onPaste={() => setShowPasteDialog(true)}
            onNewSketch={startNewSketch}
          />
        ) : isActiveSketch && activeSketch && activeFile ? (
          activeSketch.loaded ? (
            <SketchEditor
              fileName={activeFile.name}
              items={activeSketch.items}
              onItemsChange={(items) => setSketchItems(activeFile.name, items)}
              onSave={() => saveSketch(activeFile.name)}
              saving={activeSketch.saving}
              dirty={activeSketch.dirty || !activeSketch.persisted}
              onCancel={() => closeTab(activeFile.name)}
            />
          ) : (
            <div className="viewer-empty">{t('workspace.loadingSketch')}</div>
          )
        ) : activeLiveArtifact ? (
          <LiveArtifactViewer
            projectId={projectId}
            liveArtifact={activeLiveArtifact}
            liveArtifactEvents={liveArtifactEvents}
            onRefreshArtifacts={onRefreshFiles}
          />
        ) : activeFile ? (
          isDeck && isOpenPptSlideFile(activeFile.name) ? (
            <OpenSlideWorkbenchPane
              projectId={projectId}
              file={activeFile}
              files={visibleFiles}
              conversationId={activeConversationId}
              feedback={slideFeedback}
              agentBusy={streaming}
              onRefreshFiles={onRefreshFiles}
              onRefreshFeedback={onRefreshSlideFeedback}
              onApplySlideFeedback={onApplySlideFeedback}
              onInspectActiveChange={onOpenSlideInspectActiveChange}
            />
          ) : (
            <FileViewer
              projectId={projectId}
              file={activeFile}
              isDeck={isDeck}
              onExportAsPptx={onExportAsPptx}
              streaming={streaming}
              previewComments={previewComments.filter((comment) => comment.filePath === activeFile.name)}
              onSavePreviewComment={onSavePreviewComment}
              onRemovePreviewComment={onRemovePreviewComment}
            />
          )
        ) : (
          <div className="viewer-empty">
            {t('workspace.openFromDesignFiles')}{' '}
            <a
              className="link"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab(DESIGN_FILES_TAB);
              }}
            >
              {t('workspace.designFilesLink')}
            </a>
            .
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="design-files-upload-input"
        style={{ display: 'none' }}
        onChange={handleFilePicked}
      />
      {showPasteDialog ? (
        <PasteTextDialog
          onClose={() => setShowPasteDialog(false)}
          onSave={async (name, content) => {
            setShowPasteDialog(false);
            const file = await writeProjectTextFile(projectId, name, content);
            if (file) {
              await onRefreshFiles();
              openFile(file.name);
            }
          }}
        />
      ) : null}
    </div>
  );
}

interface OpenSlidePreviewPage {
  kicker: string;
  title: string;
  body: string;
}

const OPEN_SLIDE_INERT_PREVIEW_PROPS: React.HTMLAttributes<HTMLDivElement> = {
  'aria-hidden': true,
  inert: true,
};

export function OpenSlidePreviewSelectShell({
  active,
  label,
  title = label,
  className,
  hitClassName,
  children,
  onSelect,
}: {
  active: boolean;
  label: string;
  title?: string;
  className: string;
  hitClassName: string;
  children: React.ReactNode;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <div className={`${className}${active ? ' active' : ''}`}>
      <button
        type="button"
        className={hitClassName}
        onClick={onSelect}
        title={title}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
      />
      {children}
    </div>
  );
}

function decodeJsString(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(raw) as unknown;
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return raw.slice(1, -1).replace(/\\(["'`\\])/g, '$1');
  }
}

function textFromTag(source: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = source.match(pattern)?.[1];
  if (!match) return null;
  const stringExpr = match.match(/\{\s*(["'`][\s\S]*?["'`])\s*\}/)?.[1];
  const decoded = decodeJsString(stringExpr);
  if (decoded) return decoded;
  const cleaned = match
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

function componentLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim() || name;
}

function exportedPageNames(source: string): string[] {
  const match = source.match(/export\s+default\s+\[([\s\S]*?)\]\s+satisfies\s+Page\[\]/);
  if (!match) return [];
  const list = match[1];
  if (!list) return [];
  return list
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
}

function extractSlidePreviewPages(
  source: string | null,
  fallbackTitle: string,
  slideId: string | null,
): OpenSlidePreviewPage[] {
  if (!source) {
    return [{
      kicker: `OPEN SLIDE / ${slideId ?? 'DECK'}`,
      title: fallbackTitle,
      body: 'Loading editable Web-PPT source...',
    }];
  }
  const expressions = Array.from(
    source.matchAll(/\{\s*(["'`][\s\S]*?["'`])\s*\}/g),
  )
    .map((match) => decodeJsString(match[1]))
    .filter((value): value is string => (
      typeof value === 'string' &&
      value.length <= 160 &&
      !/[{}]/.test(value) &&
      !value.includes('":')
    ));
  const metaTitle = decodeJsString(source.match(/title:\s*(["'`][\s\S]*?["'`])/)?.[1]);
  const kicker = expressions[0] ?? `OPEN SLIDE / ${slideId ?? 'DECK'}`;
  const title =
    textFromTag(source, 'h1') ??
    metaTitle ??
    expressions.find((value) => value !== kicker) ??
    fallbackTitle;
  const body =
    textFromTag(source, 'p') ??
    'Editable React Page[] deck. Use the inspector or chat feedback queue to revise this slide.';
  const names = exportedPageNames(source);
  if (names.length > 0) {
    return names.map((name, index) => (
      index === 0
        ? { kicker, title, body }
        : {
            kicker: `PAGE ${String(index + 1).padStart(2, '0')}`,
            title: componentLabel(name),
            body: `SFA source page component: ${name}`,
          }
    ));
  }
  return [{ kicker, title, body }];
}

export type OpenSlideRuntimePage = (props: { design?: Record<string, any> }) => React.ReactNode;
type OpenSlidePendingEditOp =
  | (Extract<OpenSlideEditOp, { kind: 'set-style' }> & { prevValue?: string | null })
  | Extract<OpenSlideEditOp, { kind: 'set-text' }>;

type OpenSlideResizeDirection = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se';
type OpenSlideMoveDisabledReason =
  | 'no-selection'
  | 'repeated-source'
  | 'inline'
  | 'structural'
  | 'table-layout'
  | 'not-visual';

interface OpenSlidePendingBatchEdit {
  line: number;
  column: number;
  pageIndex?: number;
  targetLabel?: string;
  ops: OpenSlidePendingEditOp[];
}

type OpenSlideRedoEntry =
  | { kind: 'inspect'; edit: OpenSlidePendingBatchEdit }
  | { kind: 'design'; draft: Record<string, any> | null };

interface OpenSlideSelectedTarget {
  line: number;
  column: number;
  targetLabel: string;
  anchor?: HTMLElement;
}

interface OpenSlideMoveEligibility {
  ok: boolean;
  reason?: OpenSlideMoveDisabledReason;
}

interface OpenSlideFeedbackMarker {
  id: string;
  line: number;
  column?: number | null;
  index: number;
  note: string;
  pageIndex?: number;
}

interface OpenSlideFeedbackDraftProps {
  text: string;
  saving: boolean;
  triggerDisabled?: boolean;
  onChange: (value: string) => void;
  onQueue: () => void;
  onTrigger: () => void;
  onClose: () => void;
}

const OPEN_SLIDE_STYLE_CONTROL_KEYS = [
  'width',
  'height',
  'opacity',
  'borderRadius',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'color',
  'backgroundColor',
] as const;

const OPEN_SLIDE_TEXT_ALIGN_OPTIONS = [
  { value: 'left', icon: 'align-left', labelKey: 'openSlide.alignLeft' },
  { value: 'center', icon: 'align-center', labelKey: 'openSlide.alignCenter' },
  { value: 'right', icon: 'align-right', labelKey: 'openSlide.alignRight' },
  { value: 'justify', icon: 'align-justify', labelKey: 'openSlide.alignJustify' },
] as const;

type OpenSlideStyleControlKey = (typeof OPEN_SLIDE_STYLE_CONTROL_KEYS)[number];
type OpenSlideStyleLockReason = 'inline-layout' | 'table-layout' | 'non-text-target' | 'structural-layout';
type OpenSlideStyleLocks = Partial<Record<OpenSlideStyleControlKey, OpenSlideStyleLockReason>>;

interface OpenSlideElementSnapshot {
  tagName: string;
  display: string;
  text: string | null;
  translateX: number;
  translateY: number;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  lineHeight: number;
  letterSpacing: number;
  textAlign: string;
  color: string;
  backgroundColor: string | null;
  width: number;
  height: number;
  opacity: number;
  borderRadius: number;
  locks: OpenSlideStyleLocks;
}

export interface OpenSlideRuntimeDeck {
  pages: OpenSlideRuntimePage[];
  design?: Record<string, any>;
  meta?: { title?: string };
  error?: string;
}

function OpenSlideImagePlaceholder({
  label,
}: {
  label?: string;
}) {
  return (
    <div className="open-slide-image-placeholder">
      <span>{label || 'Image'}</span>
    </div>
  );
}

const OPEN_SLIDE_RUNTIME_ASSET_ATTRS = ['src', 'href', 'poster'] as const;
const OPEN_SLIDE_RUNTIME_STYLE_URL_KEYS = [
  'background',
  'backgroundImage',
  'borderImage',
  'borderImageSource',
  'listStyleImage',
] as const;
const OPEN_SLIDE_RUNTIME_SAFE_COMPONENT = Symbol('open-slide-runtime-safe-component');
const OPEN_SLIDE_RUNTIME_GLOBAL_PASSTHROUGH = new Set([
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'BigInt',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'Float32Array',
  'Float64Array',
  'Intl',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'RangeError',
  'ReferenceError',
  'React',
  'Reflect',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'URL',
  'URLSearchParams',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'WeakMap',
  'WeakSet',
]);
const OPEN_SLIDE_RUNTIME_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i;
const OPEN_SLIDE_RUNTIME_ASSET_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

type OpenSlideRuntimeReact = typeof React & {
  __esModule?: boolean;
  default?: typeof React;
  __openSlideTypeWrappers?: WeakMap<Function, React.ComponentType<Record<string, unknown>>>;
};

type OpenSlideRuntimeSafeComponent = React.ComponentType<Record<string, unknown>> & {
  [OPEN_SLIDE_RUNTIME_SAFE_COMPONENT]?: true;
};

function splitOpenSlideAssetSpecifier(value: string): { pathname: string; suffix: string } {
  const match = /^([^?#]*)([?#].*)?$/.exec(value);
  return {
    pathname: match?.[1] ?? value,
    suffix: match?.[2] ?? '',
  };
}

export function resolveOpenSlideRuntimeAssetUrl(projectId: string, slideId: string, specifier: string): string {
  const trimmed = specifier.trim();
  if (
    !trimmed ||
    /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(trimmed)
  ) {
    return specifier;
  }

  const { pathname, suffix } = splitOpenSlideAssetSpecifier(trimmed);
  const normalized = pathname.replace(/\\/g, '/');
  const withoutDot = normalized.replace(/^\.\//, '');

  if (withoutDot.startsWith('assets/')) {
    return `${projectRawUrl(projectId, `slides/${slideId}/${withoutDot}`)}${suffix}`;
  }

  if (!withoutDot.includes('/') && OPEN_SLIDE_RUNTIME_IMAGE_EXT_RE.test(withoutDot)) {
    return `${projectRawUrl(projectId, withoutDot)}${suffix}`;
  }

  return specifier;
}

function rewriteOpenSlideSrcSet(projectId: string, slideId: string, value: string): string {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const [url = '', ...descriptor] = trimmed.split(/\s+/);
      const rewritten = resolveOpenSlideRuntimeAssetUrl(projectId, slideId, url);
      return [rewritten, ...descriptor].join(' ');
    })
    .join(', ');
}

function rewriteOpenSlideStyleAssetUrls(
  projectId: string,
  slideId: string,
  style: Record<string, unknown>,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  for (const key of OPEN_SLIDE_RUNTIME_STYLE_URL_KEYS) {
    const value = style[key];
    if (typeof value !== 'string' || !value.includes('url(')) continue;
    const rewritten = value.replace(OPEN_SLIDE_RUNTIME_ASSET_URL_RE, (match, quote: string, rawUrl: string) => {
      const resolved = resolveOpenSlideRuntimeAssetUrl(projectId, slideId, rawUrl);
      if (resolved === rawUrl) return match;
      const escaped = resolved.replace(/"/g, '%22');
      return `url(${quote || '"'}${escaped}${quote || '"'})`;
    });
    if (rewritten !== value) {
      next ??= { ...style };
      next[key] = rewritten;
    }
  }
  return next ?? style;
}

function rewriteOpenSlideRuntimeProps(
  projectId: string,
  slideId: string,
  type: unknown,
  props: unknown,
): unknown {
  if (!props || typeof props !== 'object' || typeof type !== 'string') return props;
  const input = props as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;

  for (const attr of OPEN_SLIDE_RUNTIME_ASSET_ATTRS) {
    const value = input[attr];
    if (typeof value !== 'string') continue;
    const rewritten = resolveOpenSlideRuntimeAssetUrl(projectId, slideId, value);
    if (rewritten !== value) {
      next ??= { ...input };
      next[attr] = rewritten;
    }
  }

  if (typeof input.srcSet === 'string') {
    const rewritten = rewriteOpenSlideSrcSet(projectId, slideId, input.srcSet);
    if (rewritten !== input.srcSet) {
      next ??= { ...input };
      next.srcSet = rewritten;
    }
  }

  if (input.style && typeof input.style === 'object' && !Array.isArray(input.style)) {
    const rewrittenStyle = rewriteOpenSlideStyleAssetUrls(
      projectId,
      slideId,
      input.style as Record<string, unknown>,
    );
    if (rewrittenStyle !== input.style) {
      next ??= { ...input };
      next.style = rewrittenStyle;
    }
  }

  return next ?? props;
}

function openSlideRuntimeErrorMessage(error: unknown): string {
  return String((error as Error)?.message || error || 'Unknown render error');
}

function openSlideRuntimeComponentName(type: Function): string {
  const namedType = type as { displayName?: string; name?: string };
  return namedType.displayName || namedType.name || 'anonymous component';
}

function renderOpenSlideRuntimeComponentError(componentName: string, error: unknown): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'open-slide-runtime-error', role: 'alert' },
    React.createElement('strong', null, `Slide component failed: ${componentName}`),
    React.createElement('span', null, openSlideRuntimeErrorMessage(error)),
  );
}

function isOpenSlideReactClassComponent(type: Function): boolean {
  return Boolean((type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent);
}

function wrapOpenSlideRuntimeComponent(
  runtimeReact: OpenSlideRuntimeReact,
  type: Function,
): React.ComponentType<Record<string, unknown>> {
  if (isOpenSlideReactClassComponent(type)) {
    return type as React.ComponentType<Record<string, unknown>>;
  }

  const safeType = type as OpenSlideRuntimeSafeComponent;
  if (safeType[OPEN_SLIDE_RUNTIME_SAFE_COMPONENT]) return safeType;

  runtimeReact.__openSlideTypeWrappers ??= new WeakMap();
  const cached = runtimeReact.__openSlideTypeWrappers.get(type);
  if (cached) return cached;

  const componentName = openSlideRuntimeComponentName(type);
  const WrappedOpenSlideComponent: OpenSlideRuntimeSafeComponent = (props: Record<string, unknown>) => {
    try {
      return (type as (componentProps: Record<string, unknown>) => React.ReactNode)(props) as React.ReactElement | null;
    } catch (error) {
      return renderOpenSlideRuntimeComponentError(componentName, error);
    }
  };
  WrappedOpenSlideComponent.displayName = `OpenSlideSafe(${componentName})`;
  WrappedOpenSlideComponent[OPEN_SLIDE_RUNTIME_SAFE_COMPONENT] = true;

  runtimeReact.__openSlideTypeWrappers.set(type, WrappedOpenSlideComponent);
  return WrappedOpenSlideComponent;
}

function wrapOpenSlideRuntimeType(runtimeReact: OpenSlideRuntimeReact, type: unknown): unknown {
  if (typeof type !== 'function') return type;
  return wrapOpenSlideRuntimeComponent(runtimeReact, type);
}

function isOpenSlideMissingRuntimeIdentifier(key: string): boolean {
  return /^[A-Z][$\w]*$/.test(key) && !OPEN_SLIDE_RUNTIME_GLOBAL_PASSTHROUGH.has(key);
}

function createOpenSlideMissingRuntimeComponent(name: string): OpenSlideRuntimeSafeComponent {
  const MissingOpenSlideComponent: OpenSlideRuntimeSafeComponent = () =>
    renderOpenSlideRuntimeComponentError(name, new ReferenceError(`${name} is not defined`));
  MissingOpenSlideComponent.displayName = name;
  MissingOpenSlideComponent[OPEN_SLIDE_RUNTIME_SAFE_COMPONENT] = true;
  return MissingOpenSlideComponent;
}

function createOpenSlideRuntimeGlobals(runtimeReact: typeof React): object {
  const runtimeNamedGlobals = {
    Children: runtimeReact.Children,
    Fragment: runtimeReact.Fragment,
    Profiler: runtimeReact.Profiler,
    StrictMode: runtimeReact.StrictMode,
    Suspense: runtimeReact.Suspense,
    cloneElement: runtimeReact.cloneElement,
    createContext: runtimeReact.createContext,
    createElement: runtimeReact.createElement,
    createRef: runtimeReact.createRef,
    forwardRef: runtimeReact.forwardRef,
    isValidElement: runtimeReact.isValidElement,
    lazy: runtimeReact.lazy,
    memo: runtimeReact.memo,
    startTransition: runtimeReact.startTransition,
    useCallback: runtimeReact.useCallback,
    useContext: runtimeReact.useContext,
    useDebugValue: runtimeReact.useDebugValue,
    useDeferredValue: runtimeReact.useDeferredValue,
    useEffect: runtimeReact.useEffect,
    useId: runtimeReact.useId,
    useImperativeHandle: runtimeReact.useImperativeHandle,
    useInsertionEffect: runtimeReact.useInsertionEffect,
    useLayoutEffect: runtimeReact.useLayoutEffect,
    useMemo: runtimeReact.useMemo,
    useReducer: runtimeReact.useReducer,
    useRef: runtimeReact.useRef,
    useState: runtimeReact.useState,
    useSyncExternalStore: runtimeReact.useSyncExternalStore,
    useTransition: runtimeReact.useTransition,
  } satisfies Partial<typeof React>;
  const target = Object.assign(Object.create(null), runtimeNamedGlobals) as Record<string, unknown>;
  const missingComponents = new Map<string, OpenSlideRuntimeSafeComponent>();
  return new Proxy(target, {
    has(proxyTarget, key) {
      return (
        typeof key === 'string' &&
        (Object.hasOwn(proxyTarget, key) || isOpenSlideMissingRuntimeIdentifier(key))
      );
    },
    get(proxyTarget, key) {
      if (typeof key === 'string' && Object.hasOwn(proxyTarget, key)) return proxyTarget[key];
      if (typeof key !== 'string' || !isOpenSlideMissingRuntimeIdentifier(key)) return undefined;
      let component = missingComponents.get(key);
      if (!component) {
        component = createOpenSlideMissingRuntimeComponent(key);
        missingComponents.set(key, component);
      }
      return component;
    },
  });
}

export function OpenSlideRuntimePageView({
  page,
  design,
}: {
  page: OpenSlideRuntimePage;
  design: Record<string, any> | null | undefined;
}): React.ReactElement {
  try {
    return React.createElement(React.Fragment, null, page({ design: design ?? undefined }));
  } catch (error) {
    return renderOpenSlideRuntimeComponentError(openSlideRuntimeComponentName(page), error);
  }
}

export function createOpenSlideRuntimeReact(projectId: string, slideId: string): typeof React {
  const runtimeReact = Object.assign(Object.create(React), React) as OpenSlideRuntimeReact;
  runtimeReact.__esModule = true;
  runtimeReact.default = runtimeReact;
  runtimeReact.createElement = ((type: unknown, props: unknown, ...children: React.ReactNode[]) => (
    React.createElement(
      wrapOpenSlideRuntimeType(runtimeReact, type) as Parameters<typeof React.createElement>[0],
      rewriteOpenSlideRuntimeProps(projectId, slideId, type, props) as Parameters<typeof React.createElement>[1],
      ...children
    )
  )) as typeof React.createElement;
  return runtimeReact;
}

export function evaluateOpenSlideRuntime(
  code: string | null,
  projectId: string,
  slideId: string,
): OpenSlideRuntimeDeck | null {
  if (!code) return null;
  const module = { exports: {} as Record<string, any> };
  const runtimeReact = createOpenSlideRuntimeReact(projectId, slideId);
  const localRequire = (specifier: string) => {
    if (specifier === 'react') return runtimeReact;
    if (specifier === '@open-slide/core') {
      return {
        ImagePlaceholder: OpenSlideImagePlaceholder,
      };
    }
    if (specifier.startsWith('./assets/') || specifier.startsWith('assets/')) {
      const assetName = specifier.replace(/^\.?\/*assets\//, '');
      return `/api/projects/${encodeURIComponent(projectId)}/raw/slides/${encodeURIComponent(slideId)}/assets/${encodeURIComponent(assetName)}`;
    }
    throw new Error(`Unsupported slide import: ${specifier}`);
  };
  try {
    const runtimeGlobals = createOpenSlideRuntimeGlobals(runtimeReact);
    const run = new Function(
      'React',
      'module',
      'exports',
      'require',
      'runtimeGlobals',
      `with (runtimeGlobals) {\n${code}\n}`,
    );
    run(runtimeReact, module, module.exports, localRequire, runtimeGlobals);
    const exports = module.exports;
    const rawPages = exports.default ?? exports.pages;
    const pages = Array.isArray(rawPages)
      ? rawPages
          .filter((item): item is OpenSlideRuntimePage => typeof item === 'function')
          .map((page) => wrapOpenSlideRuntimeComponent(runtimeReact, page) as OpenSlideRuntimePage)
      : [];
    return {
      pages,
      design: exports.design && typeof exports.design === 'object' ? exports.design : undefined,
      meta: exports.meta && typeof exports.meta === 'object' ? exports.meta : undefined,
      error: pages.length === 0 ? 'Slide module did not export a Page[] default.' : undefined,
    };
  } catch (err) {
    return {
      pages: [],
      error: String((err as Error)?.message || err),
    };
  }
}

function pxToken(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`;
  if (typeof value === 'string' && value.trim()) return value;
  return fallback;
}

function openSlideDesignVars(design: Record<string, any> | null | undefined): React.CSSProperties {
  const palette = (design?.palette ?? {}) as Record<string, string>;
  const fonts = (design?.fonts ?? {}) as Record<string, string>;
  const typeScale = (design?.typeScale ?? {}) as Record<string, unknown>;
  return {
    '--osd-bg': palette.bg ?? '#0f172a',
    '--osd-text': palette.text ?? '#f8fafc',
    '--osd-accent': palette.accent ?? '#38bdf8',
    '--osd-font-display': fonts.display ?? 'system-ui, -apple-system, BlinkMacSystemFont, "Inter", sans-serif',
    '--osd-font-body': fonts.body ?? 'system-ui, -apple-system, BlinkMacSystemFont, "Inter", sans-serif',
    '--osd-size-hero': pxToken(typeScale.hero, '156px'),
    '--osd-size-body': pxToken(typeScale.body, '38px'),
    '--osd-radius': pxToken(design?.radius, '12px'),
  } as React.CSSProperties;
}

function parseSlideLoc(value: string | null): { line: number; column: number } | null {
  const match = value?.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  return { line: Number(match[1]), column: Number(match[2]) };
}

function summarizeSlideElement(el: HTMLElement): string {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 80);
  const loc = el.getAttribute('data-slide-loc');
  return `${el.tagName.toLowerCase()}${loc ? ` @ ${loc}` : ''}`;
}

function abbreviateSelectionLabel(value: string, max = 46): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return 'Selected element';
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function formatOpenSlideElapsed(ms: number): string {
  const safeMs = Math.max(0, ms);
  const minutes = Math.floor(safeMs / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function cssNumber(value: string | null | undefined, fallback = 0): number {
  if (!value || value === 'normal' || value === 'auto' || value === 'none') return fallback;
  const next = Number.parseFloat(value);
  return Number.isFinite(next) ? next : fallback;
}

function cssColorToHex(value: string | null | undefined, fallback = '#000000'): string {
  if (!value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return fallback;
  if (/^#[0-9a-f]{6}$/i.test(value.trim())) return value.trim();
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return fallback;
  return `#${[match[1], match[2], match[3]]
    .map((part) => Math.max(0, Math.min(255, Number(part) || 0)).toString(16).padStart(2, '0'))
    .join('')}`;
}

function clampNumber(value: number, min: number, max: number): number {
  const resolvedMax = Math.max(min, max);
  return Math.max(min, Math.min(value, resolvedMax));
}

function roundOpenSlidePx(value: number): number {
  return Math.round(value * 10) / 10;
}

function cssAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseOpenSlidePx(value: string | null | undefined, fallback = 0): number {
  if (!value || value === 'normal' || value === 'auto' || value === 'none') return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readOpenSlideTranslate(el: HTMLElement): { x: number; y: number } {
  const inlineTranslate = (el.style as CSSStyleDeclaration & { translate?: string }).translate;
  const computedTranslate = (window.getComputedStyle(el) as CSSStyleDeclaration & { translate?: string }).translate;
  const raw = String(inlineTranslate || computedTranslate || '').trim();
  if (!raw || raw === 'none') return { x: 0, y: 0 };
  const [xRaw, yRaw] = raw.split(/\s+/);
  return {
    x: parseOpenSlidePx(xRaw, 0),
    y: parseOpenSlidePx(yRaw ?? '0px', 0),
  };
}

function formatOpenSlideTranslate(x: number, y: number): string {
  return `${roundOpenSlidePx(x)}px ${roundOpenSlidePx(y)}px`;
}

function sameOpenSlideFrame(
  a: { left: number; top: number; width: number; height: number } | null,
  b: { left: number; top: number; width: number; height: number } | null,
): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < 1 &&
    Math.abs(a.top - b.top) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
}

function isOpenSlideStyleControlKey(key: string): key is OpenSlideStyleControlKey {
  return (OPEN_SLIDE_STYLE_CONTROL_KEYS as readonly string[]).includes(key);
}

function readOpenSlideStyleLocks(el: HTMLElement, style: CSSStyleDeclaration, hasText: boolean): OpenSlideStyleLocks {
  const locks: OpenSlideStyleLocks = {};
  const tag = el.tagName.toLowerCase();
  const display = style.display;
  const lock = (keys: OpenSlideStyleControlKey[], reason: OpenSlideStyleLockReason) => {
    for (const key of keys) locks[key] = reason;
  };

  if (display === 'inline') {
    lock(['width', 'height', 'borderRadius'], 'inline-layout');
  }

  const tableLayoutTags = new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot', 'col', 'colgroup']);
  const tableLayoutDisplays = new Set([
    'table-cell',
    'table-row',
    'table-row-group',
    'table-header-group',
    'table-footer-group',
    'table-column',
    'table-column-group',
  ]);
  if (tableLayoutTags.has(tag) || tableLayoutDisplays.has(display)) {
    lock(['width', 'height'], 'table-layout');
  }
  if (['tr', 'thead', 'tbody', 'tfoot', 'col', 'colgroup'].includes(tag) || display.includes('table-row')) {
    lock(['borderRadius'], 'table-layout');
  }

  const nonTextTags = new Set([
    'img',
    'picture',
    'video',
    'canvas',
    'svg',
    'path',
    'line',
    'polyline',
    'polygon',
    'rect',
    'circle',
    'ellipse',
  ]);
  if (nonTextTags.has(tag) || !hasText) {
    lock(['fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign'], 'non-text-target');
  }

  if (['html', 'body', 'main', 'section', 'article'].includes(tag)) {
    lock(['width', 'height'], 'structural-layout');
  }

  return locks;
}

function openSlideMoveEligibilityForTarget(target: OpenSlideSelectedTarget | null | undefined): OpenSlideMoveEligibility {
  const el = target?.anchor;
  if (!el?.isConnected) return { ok: false, reason: 'no-selection' };
  const loc = el.getAttribute('data-slide-loc');
  const canvas = el.closest<HTMLElement>('[data-osd-canvas]');
  if (loc && canvas && canvas.querySelectorAll(`[data-slide-loc="${cssAttrValue(loc)}"]`).length > 1) {
    return { ok: false, reason: 'repeated-source' };
  }

  const style = window.getComputedStyle(el);
  const tag = el.tagName.toLowerCase();
  if (style.display === 'inline' || style.display === 'contents' || style.display.startsWith('inline-')) {
    return { ok: false, reason: 'inline' };
  }

  const tableTags = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup']);
  const tableDisplays = new Set([
    'table',
    'table-row',
    'table-cell',
    'table-row-group',
    'table-header-group',
    'table-footer-group',
    'table-column',
    'table-column-group',
  ]);
  if (tableTags.has(tag) || tableDisplays.has(style.display)) {
    return { ok: false, reason: 'table-layout' };
  }

  const canvasRect = canvas?.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const structuralTag = new Set(['html', 'body', 'main']);
  if (
    structuralTag.has(tag) ||
    (canvasRect && rect.width >= canvasRect.width * 0.94 && rect.height >= canvasRect.height * 0.94)
  ) {
    return { ok: false, reason: 'structural' };
  }

  const movableDisplays = ['block', 'flex', 'grid', 'flow-root', 'list-item'];
  if (!movableDisplays.includes(style.display) && tag !== 'img' && tag !== 'svg' && tag !== 'canvas' && tag !== 'video') {
    return { ok: false, reason: 'not-visual' };
  }

  return { ok: true };
}

function openSlideMoveDisabledCopyKey(reason: OpenSlideMoveDisabledReason | undefined): keyof Dict {
  if (reason === 'repeated-source') return 'openSlide.moveDisabledRepeated';
  if (reason === 'inline') return 'openSlide.moveDisabledInline';
  if (reason === 'structural') return 'openSlide.moveDisabledStructural';
  if (reason === 'table-layout') return 'openSlide.moveDisabledTable';
  if (reason === 'not-visual') return 'openSlide.moveDisabledVisual';
  return 'openSlide.moveDisabledNoSelection';
}

function readOpenSlideElementSnapshot(el: HTMLElement | null | undefined): OpenSlideElementSnapshot | null {
  if (!el) return null;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const translate = readOpenSlideTranslate(el);
  const fontSize = cssNumber(style.fontSize, 16);
  const lineHeightRaw = cssNumber(style.lineHeight, fontSize * 1.35);
  const lineHeight = fontSize > 0 ? lineHeightRaw / fontSize : 1.35;
  return {
    tagName: el.tagName.toLowerCase(),
    display: style.display || 'block',
    text: text.length > 0 && text.length < 280 ? text : null,
    translateX: translate.x,
    translateY: translate.y,
    fontSize,
    fontWeight: cssNumber(style.fontWeight, 400),
    fontStyle: style.fontStyle || 'normal',
    lineHeight,
    letterSpacing: cssNumber(style.letterSpacing, 0),
    textAlign: style.textAlign || 'left',
    color: cssColorToHex(style.color, '#ffffff'),
    backgroundColor:
      style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
        ? cssColorToHex(style.backgroundColor, '#000000')
        : null,
    width: cssNumber(style.width, rect.width),
    height: cssNumber(style.height, rect.height),
    opacity: cssNumber(style.opacity, 1),
    borderRadius: cssNumber(style.borderRadius, 0),
    locks: readOpenSlideStyleLocks(el, style, text.length > 0),
  };
}

function cloneJsonObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function setDeepValue(base: Record<string, any>, path: string[], value: unknown): Record<string, any> {
  const next = cloneJsonObject(base || {});
  let cursor: Record<string, any> = next;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    const current = cursor[key];
    cursor[key] = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]!] = value;
  return next;
}

function feedbackToAttachment(item: SlideFeedback, order: number): ChatSlideFeedbackAttachment {
  return {
    id: item.id,
    order,
    kind: item.kind,
    slideId: item.slideId,
    pageIndex: item.pageIndex,
    line: item.line,
    column: item.column,
    targetLabel: item.targetLabel,
    note: item.note,
    source: item.source,
    payload: item.payload,
  };
}

class OpenSlideRuntimeBoundary extends React.Component<
  { resetKey: string; children: React.ReactNode; renderFailedLabel?: string },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: String((error as Error)?.message || error) };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="open-slide-runtime-error">
          <strong>{this.props.renderFailedLabel ?? 'Slide render failed'}</strong>
          <span>{this.state.error}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

export function OpenSlideCanvas({
  design,
  scale,
  center = true,
  flat = false,
  freezeMotion = false,
  className,
  inspectActive,
  moveEditing = false,
  moveEnabled = false,
  selected,
  feedbackMarkers = [],
  feedbackDraft,
  children,
  onSelectElement,
  onRequestFeedback,
  onMoveElement,
}: {
  design: Record<string, any> | null;
  scale?: number;
  center?: boolean;
  flat?: boolean;
  freezeMotion?: boolean;
  className?: string;
  inspectActive?: boolean;
  moveEditing?: boolean;
  moveEnabled?: boolean;
  selected?: OpenSlideSelectedTarget | null;
  feedbackMarkers?: OpenSlideFeedbackMarker[];
  feedbackDraft?: OpenSlideFeedbackDraftProps | null;
  children: React.ReactNode;
  onSelectElement?: (target: OpenSlideSelectedTarget) => void;
  onRequestFeedback?: (target: OpenSlideSelectedTarget) => void;
  onMoveElement?: (target: OpenSlideSelectedTarget, ops: OpenSlidePendingEditOp[], anchor: HTMLElement) => void;
}) {
  const t = useT();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const hoverRef = useRef<HTMLElement | null>(null);
  const moveFrameRef = useRef(0);
  const moveJustFinishedRef = useRef(false);
  const moveInteractionRef = useRef<{
    mode: 'move' | 'resize';
    direction?: OpenSlideResizeDirection;
    target: OpenSlideSelectedTarget;
    anchor: HTMLElement;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    baseTranslateX: number;
    baseTranslateY: number;
    baseWidth: number;
    baseHeight: number;
    changed: boolean;
  } | null>(null);
  const [fitScale, setFitScale] = useState(0.4);
  const [moveActive, setMoveActive] = useState(false);
  const [selectionFrame, setSelectionFrame] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    state: 'hover' | 'selected';
  } | null>(null);
  const [hoverFrame, setHoverFrame] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [shellSize, setShellSize] = useState({ width: 0, height: 0 });
  const [markerFrames, setMarkerFrames] = useState<Array<OpenSlideFeedbackMarker & {
    left: number;
    top: number;
    width: number;
    height: number;
  }>>([]);

  function clearMarkerFrames() {
    setMarkerFrames((current) => (current.length === 0 ? current : []));
  }

  useEffect(() => {
    if (scale !== undefined) return undefined;
    const shell = shellRef.current;
    if (!shell) return undefined;
    const resize = () => {
      const rect = shell.getBoundingClientRect();
      setShellSize({ width: rect.width, height: rect.height });
      const nextScale = Math.min(
        Math.max(0.05, rect.width / 1920),
        Math.max(0.05, rect.height / 1080),
      );
      setFitScale(Number.isFinite(nextScale) ? nextScale : 0.4);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [scale]);

  const resolvedScale = scale ?? fitScale;

  function clearSelectionFrame() {
    setSelectionFrame((current) => (current === null ? current : null));
  }

  useEffect(() => {
    const root = frameRef.current;
    if (!root) return;
    root
      .querySelectorAll<HTMLElement>('[data-open-slide-selected="true"]')
      .forEach((item) => item.removeAttribute('data-open-slide-selected'));
    if (!inspectActive || !selected) {
      clearSelectionFrame();
      return;
    }
    const next = selected.anchor?.isConnected
      ? selected.anchor
      : root.querySelector<HTMLElement>(
      `[data-slide-loc="${selected.line}:${selected.column}"]`,
    );
    next?.setAttribute('data-open-slide-selected', 'true');
    measureSelectionFrame(next ?? null, 'selected');
  }, [children, inspectActive, selected]);

  function measureSelectionFrame(el: HTMLElement | null, state: 'hover' | 'selected' = 'selected') {
    const shell = shellRef.current;
    if (!shell || !el?.isConnected) {
      clearSelectionFrame();
      return;
    }
    const shellRect = shell.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const nextFrame = {
      left: rect.left - shellRect.left,
      top: rect.top - shellRect.top,
      width: rect.width,
      height: rect.height,
      state,
    };
    setSelectionFrame((current) => (
      current?.state === state && sameOpenSlideFrame(current, nextFrame) ? current : nextFrame
    ));
  }

  function measureHoverFrame(el: HTMLElement | null) {
    const shell = shellRef.current;
    if (!shell || !el?.isConnected) {
      setHoverFrame(null);
      return;
    }
    const shellRect = shell.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    setHoverFrame({
      left: rect.left - shellRect.left,
      top: rect.top - shellRect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  useEffect(() => {
    if (!inspectActive || !selected) return undefined;
    const root = frameRef.current;
    const target = selected.anchor?.isConnected
      ? selected.anchor
      : root?.querySelector<HTMLElement>(`[data-slide-loc="${selected.line}:${selected.column}"]`) ?? null;
    measureSelectionFrame(target, 'selected');
    if (!target || !shellRef.current) return undefined;
    const onResize = () => measureSelectionFrame(target, 'selected');
    const observer = new ResizeObserver(() => measureSelectionFrame(target, 'selected'));
    observer.observe(target);
    observer.observe(shellRef.current);
    window.addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      measureSelectionFrame(null, 'selected');
    };
  }, [inspectActive, selected, resolvedScale]);

  useEffect(() => () => {
    finishMoveInteraction(true);
  }, []);

  function measureMarkerFrames() {
    const shell = shellRef.current;
    const root = frameRef.current;
    if (!shell || !root || feedbackMarkers.length === 0) {
      clearMarkerFrames();
      return;
    }
    const shellRect = shell.getBoundingClientRect();
    const next = feedbackMarkers.flatMap((marker) => {
      const column = Number.isFinite(Number(marker.column)) ? Number(marker.column) : 0;
      const target = root.querySelector<HTMLElement>(`[data-slide-loc="${marker.line}:${column}"]`);
      if (!target) return [];
      const rect = target.getBoundingClientRect();
      return [{
        ...marker,
        left: rect.left - shellRect.left,
        top: rect.top - shellRect.top,
        width: rect.width,
        height: rect.height,
      }];
    });
    setMarkerFrames(next);
  }

  useEffect(() => {
    if (feedbackMarkers.length === 0) {
      clearMarkerFrames();
      return undefined;
    }
    const shell = shellRef.current;
    const root = frameRef.current;
    const frame = window.requestAnimationFrame(measureMarkerFrames);
    if (!shell || !root) return () => window.cancelAnimationFrame(frame);
    const observer = new ResizeObserver(measureMarkerFrames);
    observer.observe(shell);
    observer.observe(root);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [children, feedbackMarkers, resolvedScale]);

  const draftStyle = (() => {
    if (!inspectActive || !selected || !selectionFrame || !feedbackDraft) return null;
    const width = Math.min(420, Math.max(320, (shellSize.width || 420) - 24));
    const height = 206;
    const gap = 18;
    const pad = 14;
    const shellWidth = shellSize.width || width + pad * 2;
    const shellHeight = shellSize.height || height + pad * 2;
    const maxLeft = Math.max(pad, shellWidth - width - pad);
    const maxTop = Math.max(pad, shellHeight - height - pad);
    const centeredLeft = clampNumber(
      selectionFrame.left + selectionFrame.width / 2 - width / 2,
      pad,
      maxLeft,
    );
    const centeredTop = clampNumber(
      selectionFrame.top + selectionFrame.height / 2 - height / 2,
      pad,
      maxTop,
    );
    const rightLeft = selectionFrame.left + selectionFrame.width + gap;
    const leftLeft = selectionFrame.left - width - gap;
    const belowTop = selectionFrame.top + selectionFrame.height + gap;
    const aboveTop = selectionFrame.top - height - gap;
    const candidates = [
      { left: centeredLeft, top: belowTop },
      { left: centeredLeft, top: aboveTop },
      { left: rightLeft, top: centeredTop },
      { left: leftLeft, top: centeredTop },
      { left: maxLeft, top: maxTop },
      { left: pad, top: pad },
    ];
    const selectionRect = {
      left: selectionFrame.left - gap / 2,
      right: selectionFrame.left + selectionFrame.width + gap / 2,
      top: selectionFrame.top - gap / 2,
      bottom: selectionFrame.top + selectionFrame.height + gap / 2,
    };
    const intersects = (candidate: { left: number; top: number }) => {
      const clamped = {
        left: clampNumber(candidate.left, pad, maxLeft),
        top: clampNumber(candidate.top, pad, maxTop),
      };
      return !(
        clamped.left + width <= selectionRect.left ||
        clamped.left >= selectionRect.right ||
        clamped.top + height <= selectionRect.top ||
        clamped.top >= selectionRect.bottom
      );
    };
    const chosen = candidates.find((candidate) => !intersects(candidate)) ?? candidates[0]!;
    return {
      left: clampNumber(chosen.left, pad, maxLeft),
      top: clampNumber(chosen.top, pad, maxTop),
      width,
    } as React.CSSProperties;
  })();

  const feedbackActionStyle = (() => {
    if (!inspectActive || !selected || !selectionFrame || !onRequestFeedback) return null;
    const width = 88;
    const height = 30;
    const gap = 8;
    const inset = 10;
    const pad = 8;
    const shellWidth = shellSize.width || selectionFrame.left + selectionFrame.width + width + pad;
    const shellHeight = shellSize.height || selectionFrame.top + selectionFrame.height + height + pad;
    const maxLeft = Math.max(pad, shellWidth - width - pad);
    const maxTop = Math.max(pad, shellHeight - height - pad);
    const hasRoomAbove = selectionFrame.top >= height + gap + pad;
    const preferredLeft = selectionFrame.left + selectionFrame.width - width;
    const preferredTop = hasRoomAbove
      ? selectionFrame.top - height - gap
      : selectionFrame.top + inset;

    return {
      left: clampNumber(preferredLeft, pad, maxLeft),
      top: clampNumber(preferredTop, pad, maxTop),
    } as React.CSSProperties;
  })();

  function markHover(el: HTMLElement | null) {
    if (hoverRef.current) {
      hoverRef.current.removeAttribute('data-open-slide-hover');
    }
    hoverRef.current = el;
    el?.setAttribute('data-open-slide-hover', 'true');
    if (inspectActive) measureHoverFrame(el);
    else setHoverFrame(null);
  }

  function findInspectableElementAtPoint(clientX: number, clientY: number): HTMLElement | null {
    const root = frameRef.current;
    if (!root) return null;
    const stack = document.elementsFromPoint(clientX, clientY);
    let selectedCandidate: HTMLElement | null = null;
    for (const item of stack) {
      if (!(item instanceof HTMLElement) || !root.contains(item)) continue;
      const target = item.closest<HTMLElement>('[data-slide-loc]');
      if (!target || !root.contains(target)) continue;
      if (target.getAttribute('data-open-slide-selected') === 'true') {
        selectedCandidate ??= target;
        continue;
      }
      return target;
    }
    return selectedCandidate;
  }

  function resolveSelectedMoveAnchor(): HTMLElement | null {
    const root = frameRef.current;
    if (!selected || !root) return null;
    return selected.anchor?.isConnected
      ? selected.anchor
      : root.querySelector<HTMLElement>(`[data-slide-loc="${selected.line}:${selected.column}"]`);
  }

  function resizeCursorForDirection(direction: OpenSlideResizeDirection): string {
    if (direction === 'n' || direction === 's') return 'ns-resize';
    if (direction === 'w' || direction === 'e') return 'ew-resize';
    if (direction === 'nw' || direction === 'se') return 'nwse-resize';
    return 'nesw-resize';
  }

  function applyMoveInteraction(clientX: number, clientY: number) {
    const state = moveInteractionRef.current;
    if (!state) return;
    const scaleFactor = resolvedScale || 1;
    const deltaX = (clientX - state.startClientX) / scaleFactor;
    const deltaY = (clientY - state.startClientY) / scaleFactor;
    const anchorStyle = state.anchor.style as CSSStyleDeclaration & { translate?: string };

    if (state.mode === 'move') {
      const nextX = state.baseTranslateX + deltaX;
      const nextY = state.baseTranslateY + deltaY;
      anchorStyle.translate = formatOpenSlideTranslate(nextX, nextY);
      state.changed = state.changed || Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5;
      measureSelectionFrame(state.anchor, 'selected');
      return;
    }

    const direction = state.direction ?? 'se';
    const affectsWidth = direction.includes('w') || direction.includes('e');
    const affectsHeight = direction.includes('n') || direction.includes('s');
    const widthDelta = direction.includes('w') ? -deltaX : direction.includes('e') ? deltaX : 0;
    const heightDelta = direction.includes('n') ? -deltaY : direction.includes('s') ? deltaY : 0;
    const nextWidth = affectsWidth ? clampNumber(state.baseWidth + widthDelta, 12, 1920) : state.baseWidth;
    const nextHeight = affectsHeight ? clampNumber(state.baseHeight + heightDelta, 12, 1080) : state.baseHeight;
    const nextX = state.baseTranslateX + (direction.includes('w') ? state.baseWidth - nextWidth : 0);
    const nextY = state.baseTranslateY + (direction.includes('n') ? state.baseHeight - nextHeight : 0);
    state.anchor.style.width = `${roundOpenSlidePx(nextWidth)}px`;
    state.anchor.style.height = `${roundOpenSlidePx(nextHeight)}px`;
    anchorStyle.translate = formatOpenSlideTranslate(nextX, nextY);
    state.changed =
      state.changed ||
      Math.abs(nextWidth - state.baseWidth) >= 0.5 ||
      Math.abs(nextHeight - state.baseHeight) >= 0.5 ||
      Math.abs(nextX - state.baseTranslateX) >= 0.5 ||
      Math.abs(nextY - state.baseTranslateY) >= 0.5;
    measureSelectionFrame(state.anchor, 'selected');
  }

  function finishMoveInteraction(cancelled = false) {
    const state = moveInteractionRef.current;
    if (!state) return;
    moveInteractionRef.current = null;
    if (moveFrameRef.current) {
      window.cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = 0;
    }
    setMoveActive(false);
    if (state.anchor.hasPointerCapture?.(state.pointerId)) {
      state.anchor.releasePointerCapture(state.pointerId);
    }
    document.body.style.cursor = '';
    if (cancelled || !state.changed) {
      measureSelectionFrame(state.anchor, 'selected');
      return;
    }
    moveJustFinishedRef.current = true;
    window.setTimeout(() => {
      moveJustFinishedRef.current = false;
    }, 0);
    const translate = readOpenSlideTranslate(state.anchor);
    const ops: OpenSlidePendingEditOp[] = [{
      kind: 'set-style',
      key: 'translate',
      value: formatOpenSlideTranslate(translate.x, translate.y),
      prevValue: formatOpenSlideTranslate(state.baseTranslateX, state.baseTranslateY),
    }];
    if (state.mode === 'resize') {
      const width = parseOpenSlidePx(state.anchor.style.width, state.baseWidth);
      const height = parseOpenSlidePx(state.anchor.style.height, state.baseHeight);
      ops.push(
        {
          kind: 'set-style',
          key: 'width',
          value: `${roundOpenSlidePx(width)}px`,
          prevValue: `${roundOpenSlidePx(state.baseWidth)}px`,
        },
        {
          kind: 'set-style',
          key: 'height',
          value: `${roundOpenSlidePx(height)}px`,
          prevValue: `${roundOpenSlidePx(state.baseHeight)}px`,
        },
      );
    }
    onMoveElement?.(state.target, ops, state.anchor);
  }

  function startMoveInteraction(
    event: React.PointerEvent<HTMLDivElement>,
    mode: 'move' | 'resize',
    direction?: OpenSlideResizeDirection,
  ): boolean {
    if (!moveEditing || !moveEnabled || !selected) return false;
    const anchor = resolveSelectedMoveAnchor();
    if (!anchor || openSlideMoveEligibilityForTarget({ ...selected, anchor }).ok !== true) return false;
    if (mode === 'move') {
      const stack = document.elementsFromPoint(event.clientX, event.clientY);
      const hitsSelectedAnchor = stack.some((item) => (
        item instanceof Node && (item === anchor || anchor.contains(item))
      ));
      if (!hitsSelectedAnchor) return false;
    }
    const computed = window.getComputedStyle(anchor);
    const translate = readOpenSlideTranslate(anchor);
    const rect = anchor.getBoundingClientRect();
    moveInteractionRef.current = {
      mode,
      direction,
      target: { ...selected, anchor },
      anchor,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      baseTranslateX: translate.x,
      baseTranslateY: translate.y,
      baseWidth: parseOpenSlidePx(computed.width, rect.width / (resolvedScale || 1)),
      baseHeight: parseOpenSlidePx(computed.height, rect.height / (resolvedScale || 1)),
      changed: false,
    };
    setMoveActive(true);
    anchor.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = mode === 'resize' && direction ? resizeCursorForDirection(direction) : 'move';
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (moveInteractionRef.current) {
      const clientX = event.clientX;
      const clientY = event.clientY;
      if (!moveFrameRef.current) {
        moveFrameRef.current = window.requestAnimationFrame(() => {
          moveFrameRef.current = 0;
          applyMoveInteraction(clientX, clientY);
        });
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!inspectActive) return;
    markHover(findInspectableElementAtPoint(event.clientX, event.clientY));
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!inspectActive || event.button !== 0) return;
    const handle = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-open-slide-resize-handle]')
      : null;
    const direction = handle?.dataset.openSlideResizeHandle as OpenSlideResizeDirection | undefined;
    if (direction && startMoveInteraction(event, 'resize', direction)) return;
    startMoveInteraction(event, 'move');
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!moveInteractionRef.current) return;
    applyMoveInteraction(event.clientX, event.clientY);
    finishMoveInteraction();
    event.preventDefault();
    event.stopPropagation();
  }

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (moveActive || moveJustFinishedRef.current) {
      moveJustFinishedRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!inspectActive) return;
    const target = findInspectableElementAtPoint(event.clientX, event.clientY);
    if (!target) return;
    const loc = parseSlideLoc(target.getAttribute('data-slide-loc'));
    if (!loc) return;
    event.preventDefault();
    event.stopPropagation();
    markHover(target);
    onSelectElement?.({
      ...loc,
      targetLabel: summarizeSlideElement(target),
      anchor: target,
    });
  }

  function handleContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    if (!inspectActive) return;
    const target = findInspectableElementAtPoint(event.clientX, event.clientY);
    if (!target) return;
    const loc = parseSlideLoc(target.getAttribute('data-slide-loc'));
    if (!loc) return;
    event.preventDefault();
    event.stopPropagation();
    markHover(target);
    onRequestFeedback?.({
      ...loc,
      targetLabel: summarizeSlideElement(target),
      anchor: target,
    });
  }

  const showHoverFrame = inspectActive && hoverFrame && !sameOpenSlideFrame(hoverFrame, selectionFrame);
  const showMoveHandles = moveEditing && moveEnabled && selectionFrame && selected;

  return (
    <div
      ref={shellRef}
      className={[
        'open-slide-canvas-shell',
        center ? 'is-centered' : '',
        flat ? 'is-flat' : '',
        inspectActive ? 'inspect-active' : '',
        moveEditing ? 'move-editing' : '',
        moveActive ? 'move-active' : '',
        selected ? 'has-selected' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => finishMoveInteraction(true)}
      onPointerLeave={() => markHover(null)}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {showHoverFrame ? (
        <div
          aria-hidden
          className="open-slide-selection-frame is-hover"
          style={{
            left: hoverFrame.left,
            top: hoverFrame.top,
            width: hoverFrame.width,
            height: hoverFrame.height,
          }}
        />
      ) : null}
      {inspectActive && selectionFrame ? (
        <div
          aria-hidden
          className="open-slide-selection-frame is-selected"
          style={{
            left: selectionFrame.left,
            top: selectionFrame.top,
            width: selectionFrame.width,
            height: selectionFrame.height,
          }}
        />
      ) : null}
      {showMoveHandles ? (
        <div
          aria-hidden
          className="open-slide-move-overlay"
          style={{
            left: selectionFrame.left,
            top: selectionFrame.top,
            width: selectionFrame.width,
            height: selectionFrame.height,
          }}
        >
          {(['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'] as const).map((direction) => (
            <span
              key={direction}
              className="open-slide-resize-handle"
              data-open-slide-resize-handle={direction}
            />
          ))}
        </div>
      ) : null}
      {feedbackActionStyle && selected ? (
        <button
          type="button"
          className="open-slide-selection-feedback-action"
          style={feedbackActionStyle}
          aria-label={t('openSlide.feedback.add')}
          title={t('openSlide.feedback.add')}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestFeedback?.(selected);
          }}
        >
          <Icon name="comment" size={14} />
          <span>{t('openSlide.feedback')}</span>
        </button>
      ) : null}
      <div
        className="open-slide-canvas-frame"
        style={{
          width: 1920 * resolvedScale,
          height: 1080 * resolvedScale,
          ...(center
            ? {
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
              }
            : {}),
        }}
      >
        <div
          ref={frameRef}
          data-osd-canvas
          data-osd-freeze-motion={freezeMotion ? '' : undefined}
          className="open-slide-canvas-runtime"
          style={{
            ...openSlideDesignVars(design),
            transform: `scale(${resolvedScale})`,
          }}
        >
          {children}
        </div>
      </div>
      {markerFrames.map((marker) => (
        <div
          key={marker.id}
          className="open-slide-feedback-marker"
          style={{
            left: marker.left + marker.width,
            top: marker.top,
          }}
          title={marker.note}
        >
          {marker.index}
        </div>
      ))}
      {draftStyle && feedbackDraft ? (
        <div
          className="open-slide-feedback-draft"
          style={draftStyle}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="open-slide-feedback-draft-head">
            <span>
              <Icon name="comment" size={13} />
              {t('openSlide.feedback.add')}
            </span>
            <button type="button" aria-label={t('openSlide.feedback.close')} onClick={feedbackDraft.onClose}>
              <Icon name="close" size={13} />
            </button>
          </div>
          <textarea
            value={feedbackDraft.text}
            autoFocus
            placeholder={t('openSlide.feedback.placeholder')}
            onChange={(event) => feedbackDraft.onChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                feedbackDraft.onQueue();
              }
            }}
          />
          <div className="open-slide-feedback-draft-actions">
            <button type="button" disabled={feedbackDraft.saving || !feedbackDraft.text.trim()} onClick={feedbackDraft.onQueue}>
              <Icon name="comment" size={13} />
              {t('openSlide.feedback.queue')}
            </button>
            <button type="button" className="primary" disabled={feedbackDraft.saving || feedbackDraft.triggerDisabled || !feedbackDraft.text.trim()} onClick={feedbackDraft.onTrigger}>
              <Icon name="sparkles" size={13} />
              {t('openSlide.feedback.triggerAgent')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function OpenSlideFallbackPreview({
  page,
  palette,
}: {
  page: OpenSlidePreviewPage;
  palette: Record<string, string>;
}) {
  return (
    <div
      className="open-slide-fallback-page"
      style={{
        background: palette.bg ?? '#0f172a',
        color: palette.text ?? '#f8fafc',
        ['--open-slide-accent' as string]: palette.accent ?? '#38bdf8',
      }}
    >
      <div className="open-slide-canvas-kicker">{page.kicker}</div>
      <div className="open-slide-canvas-title">{page.title}</div>
      <p className="open-slide-canvas-body">{page.body}</p>
    </div>
  );
}

type OpenSlidePlayerTransitionDirection = 'initial' | 'forward' | 'backward' | 'jump';

function clampOpenSlidePlayerIndex(value: number, pageCount: number) {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(value, 0), pageCount - 1);
}

export function OpenSlidePlayerOverlay({
  pages,
  design,
  activeIndex,
  onSelect,
  onClose,
}: {
  pages: OpenSlideRuntimePage[];
  design: Record<string, any> | null;
  activeIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [pageState, setPageState] = useState<{ index: number; direction: OpenSlidePlayerTransitionDirection }>(() => ({
    index: clampOpenSlidePlayerIndex(activeIndex, pages.length),
    direction: 'initial',
  }));
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [blackout, setBlackout] = useState<'black' | 'white' | null>(null);
  const [laser, setLaser] = useState(false);
  const [laserPoint, setLaserPoint] = useState({ x: 50, y: 50 });
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [controlsVisible, setControlsVisible] = useState(true);
  const [bottomHot, setBottomHot] = useState(false);
  const pageCount = pages.length;
  const index = clampOpenSlidePlayerIndex(pageState.index, pageCount);
  const transitionDirection = pageState.direction;
  const Page = pages[Math.min(index, pageCount - 1)];
  const elapsed = formatOpenSlideElapsed(now - startedAt);
  const showControls = controlsVisible || bottomHot || overviewOpen || helpOpen;

  const updatePlayerIndex = useCallback((resolveNext: number | ((current: number) => number), reason: 'step' | 'jump' = 'step') => {
    setPageState((current) => {
      const currentIndex = clampOpenSlidePlayerIndex(current.index, pageCount);
      const nextIndex = clampOpenSlidePlayerIndex(
        typeof resolveNext === 'function' ? resolveNext(currentIndex) : resolveNext,
        pageCount,
      );
      if (nextIndex === currentIndex) {
        return current.index === currentIndex ? current : { ...current, index: currentIndex };
      }
      return {
        index: nextIndex,
        direction: reason === 'jump' ? 'jump' : nextIndex > currentIndex ? 'forward' : 'backward',
      };
    });
  }, [pageCount]);

  const goPrev = useCallback(() => {
    updatePlayerIndex((curr) => curr - 1);
  }, [updatePlayerIndex]);

  const goNext = useCallback(() => {
    updatePlayerIndex((curr) => curr + 1);
  }, [updatePlayerIndex]);

  useEffect(() => {
    updatePlayerIndex(activeIndex, 'jump');
  }, [activeIndex, updatePlayerIndex]);

  const revealControls = useCallback((persistent = false) => {
    setControlsVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (!persistent) {
      hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2200);
    }
  }, []);

  useEffect(() => {
    revealControls();
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [revealControls]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    el.requestFullscreen?.().catch(() => {});
    const onFullscreenChange = () => {
      revealControls(true);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (document.fullscreenElement === el) {
        document.exitFullscreen?.().catch(() => {});
      }
    };
  }, [revealControls]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches('input, textarea')) return;
      revealControls();
      if (helpOpen || overviewOpen) {
        if (event.key === 'Escape') {
          setHelpOpen(false);
          setOverviewOpen(false);
        }
        return;
      }
      if (event.key === 'Escape') {
        if (blackout) {
          setBlackout(null);
          return;
        }
        onClose();
      } else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        setBlackout(null);
        goNext();
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        setBlackout(null);
        goPrev();
      } else if (event.key === 'Home') {
        updatePlayerIndex(0, 'jump');
      } else if (event.key === 'End') {
        updatePlayerIndex(pageCount - 1, 'jump');
      } else if (event.key === 'b' || event.key === 'B') {
        setBlackout((curr) => (curr === 'black' ? null : 'black'));
      } else if (event.key === 'w' || event.key === 'W') {
        setBlackout((curr) => (curr === 'white' ? null : 'white'));
      } else if (event.key === 'o' || event.key === 'O') {
        setOverviewOpen((curr) => !curr);
      } else if (event.key === 'l' || event.key === 'L') {
        setLaser((curr) => !curr);
      } else if (event.key === 'h' || event.key === 'H' || event.key === '?') {
        setHelpOpen((curr) => !curr);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blackout, goNext, goPrev, helpOpen, onClose, overviewOpen, pageCount, revealControls, updatePlayerIndex]);

  useEffect(() => {
    onSelect(index);
  }, [index, onSelect]);

  if (!Page) return null;

  return (
    <div
      ref={rootRef}
      className={`open-slide-player ${laser ? 'laser-enabled' : ''} ${showControls ? 'controls-visible' : 'controls-hidden'}`}
      role="dialog"
      aria-modal="true"
      aria-label={t('openSlide.player.aria')}
      onPointerMove={(event) => {
        revealControls();
        setBottomHot(event.clientY >= window.innerHeight - 156);
        if (!laser) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setLaserPoint({
          x: ((event.clientX - rect.left) / rect.width) * 100,
          y: ((event.clientY - rect.top) / rect.height) * 100,
        });
      }}
      onPointerLeave={() => setBottomHot(false)}
    >
      <div
        key={`player-stage-${index}`}
        className="open-slide-player-stage"
        data-transition={transitionDirection}
        data-page-index={index}
        data-testid="open-slide-player-stage"
      >
        <OpenSlideCanvas design={design} flat>
          <OpenSlideRuntimeBoundary resetKey={`player-${index}`} renderFailedLabel={t('openSlide.renderFailed')}>
            <OpenSlideRuntimePageView page={Page} design={design} />
          </OpenSlideRuntimeBoundary>
        </OpenSlideCanvas>
      </div>
      <button
        type="button"
        className="open-slide-player-zone prev"
        aria-label={t('openSlide.player.previous')}
        disabled={index === 0}
        onClick={goPrev}
      />
      <button
        type="button"
        className="open-slide-player-zone next"
        aria-label={t('openSlide.player.next')}
        disabled={index === pageCount - 1}
        onClick={goNext}
      />
      <div className="open-slide-player-progress" data-visible={showControls ? 'true' : 'false'} aria-hidden>
        <span style={{ width: `${((index + 1) / pageCount) * 100}%` }} />
      </div>
      {blackout ? <div className={`open-slide-player-blackout ${blackout}`} /> : null}
      {laser ? (
        <div
          className="open-slide-player-laser"
          style={{ left: `${laserPoint.x}%`, top: `${laserPoint.y}%` }}
        />
      ) : null}
      <div className="open-slide-player-controls" data-visible={showControls ? 'true' : 'false'}>
        <button type="button" onClick={goPrev} disabled={index === 0} title={t('openSlide.player.previous')}>
          <Icon name="chevron-left" size={18} strokeWidth={2} />
        </button>
        <button type="button" onClick={goNext} disabled={index === pageCount - 1} title={t('openSlide.player.next')}>
          <Icon name="chevron-right" size={18} strokeWidth={2} />
        </button>
        <span aria-hidden className="open-slide-player-control-sep" />
        <span className="open-slide-player-folio">
          {String(index + 1).padStart(2, '0')} / {String(pageCount).padStart(2, '0')}
        </span>
        <span aria-hidden className="open-slide-player-control-sep" />
        <span className="open-slide-player-time">{elapsed}</span>
        <span aria-hidden className="open-slide-player-control-sep" />
        <button type="button" onClick={() => setOverviewOpen(true)} title={t('openSlide.player.overview')}>
          <Icon name="grid" size={18} strokeWidth={1.9} />
        </button>
        <button
          type="button"
          className={blackout === 'black' ? 'active' : ''}
          title={t('openSlide.player.blackout')}
          onClick={() => setBlackout((curr) => (curr === 'black' ? null : 'black'))}
        >
          <span aria-hidden className="open-slide-player-swatch black" />
        </button>
        <button
          type="button"
          className={blackout === 'white' ? 'active' : ''}
          title={t('openSlide.player.whiteout')}
          onClick={() => setBlackout((curr) => (curr === 'white' ? null : 'white'))}
        >
          <span aria-hidden className="open-slide-player-swatch white" />
        </button>
        <button type="button" className={laser ? 'active' : ''} onClick={() => setLaser((curr) => !curr)} title={t('openSlide.player.laser')}>
          <Icon name="target" size={18} strokeWidth={1.9} />
        </button>
        <button type="button" onClick={() => setHelpOpen(true)} title={t('openSlide.player.help')}>
          <Icon name="keyboard" size={18} strokeWidth={1.8} />
        </button>
        <span aria-hidden className="open-slide-player-control-sep" />
        <button type="button" onClick={onClose} title={t('openSlide.player.exit')}>
          <Icon name="log-out" size={18} strokeWidth={1.9} />
        </button>
      </div>
      {overviewOpen ? (
        <div className="open-slide-present-sheet" role="dialog" aria-label={t('openSlide.player.overview')}>
          <div className="open-slide-present-sheet-head">
            <strong>{t('openSlide.player.overview')}</strong>
            <button type="button" onClick={() => setOverviewOpen(false)}>{t('common.close')}</button>
          </div>
          <div className="open-slide-present-grid">
            {pages.map((PageComp, pageIndex) => (
              <OpenSlidePreviewSelectShell
                // biome-ignore lint/suspicious/noArrayIndexKey: page order is stable inside a loaded module
                key={pageIndex}
                className="open-slide-present-card"
                hitClassName="open-slide-present-hit-target"
                active={pageIndex === index}
                label={`Page ${String(pageIndex + 1).padStart(2, '0')}`}
                onSelect={() => {
                  updatePlayerIndex(pageIndex, 'jump');
                  setOverviewOpen(false);
                }}
              >
                <div className="open-slide-present-preview" {...OPEN_SLIDE_INERT_PREVIEW_PROPS}>
                  <OpenSlideCanvas scale={0.115} center={false} flat freezeMotion design={design}>
                    <OpenSlideRuntimeBoundary resetKey={`player-overview-${pageIndex}`} renderFailedLabel={t('openSlide.renderFailed')}>
                      <OpenSlideRuntimePageView page={PageComp} design={design} />
                    </OpenSlideRuntimeBoundary>
                  </OpenSlideCanvas>
                </div>
                <span>{String(pageIndex + 1).padStart(2, '0')}</span>
              </OpenSlidePreviewSelectShell>
            ))}
          </div>
        </div>
      ) : null}
      {helpOpen ? (
        <div className="open-slide-present-help" role="dialog" aria-label={t('openSlide.player.help')}>
          <div>
            <strong>{t('openSlide.player.helpTitle')}</strong>
            <p>{t('openSlide.player.helpBody')}</p>
            <button type="button" onClick={() => setHelpOpen(false)}>{t('openSlide.player.gotIt')}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function OpenSlideWorkbenchPane({
  projectId,
  file,
  files,
  conversationId,
  feedback,
  agentBusy = false,
  onRefreshFiles,
  onRefreshFeedback,
  onApplySlideFeedback,
  onInspectActiveChange,
}: {
  projectId: string;
  file: ProjectFile;
  files: ProjectFile[];
  conversationId: string | null;
  feedback: SlideFeedback[];
  agentBusy?: boolean;
  onRefreshFiles?: () => Promise<void> | void;
  onRefreshFeedback?: () => Promise<void> | void;
  onApplySlideFeedback?: (prompt: string, attachments?: ChatSlideFeedbackAttachment[]) => void;
  onInspectActiveChange?: (active: boolean) => void;
}) {
  const t = useT();
  const slideId = slideIdFromPath(file.name);
  const [source, setSource] = useState<string | null>(null);
  const [moduleCode, setModuleCode] = useState<string | null>(null);
  const [moduleDiagnostics, setModuleDiagnostics] = useState<Array<{ message: string }> | null>(null);
  const [design, setDesign] = useState<Record<string, any> | null>(null);
  const [designDraft, setDesignDraft] = useState<Record<string, any> | null>(null);
  const [commentText, setCommentText] = useState('');
  const [commentLine, setCommentLine] = useState(1);
  const [commentColumn, setCommentColumn] = useState<number | null>(0);
  const [selectedTarget, setSelectedTarget] = useState<OpenSlideSelectedTarget | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<OpenSlideElementSnapshot | null>(null);
  const [pendingInspectEdits, setPendingInspectEdits] = useState<OpenSlidePendingBatchEdit[]>([]);
  const [redoStack, setRedoStack] = useState<OpenSlideRedoEntry[]>([]);
  const pendingInspectEditsRef = useRef<OpenSlidePendingBatchEdit[]>([]);
  const undoInspectStackRef = useRef<OpenSlidePendingBatchEdit[]>([]);
  const redoStackRef = useRef<OpenSlideRedoEntry[]>([]);
  const designDraftRef = useRef<Record<string, any> | null>(null);
  const historyReplayRef = useRef(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [inspectActive, setInspectActive] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const [view, setView] = useState<'slides' | 'assets'>('slides');
  const [commentOpen, setCommentOpen] = useState(false);
  const [feedbackDraftOpen, setFeedbackDraftOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [assetPreview, setAssetPreview] = useState<ProjectFile | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState<OpenSlideExportKind | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const inspectActiveChangeRef = useRef(onInspectActiveChange);

  useEffect(() => {
    inspectActiveChangeRef.current = onInspectActiveChange;
  }, [onInspectActiveChange]);

  useEffect(() => {
    if (!exportMenuOpen) return undefined;
    function onDocClick(e: MouseEvent) {
      if (!exportMenuRef.current) return;
      if (!exportMenuRef.current.contains(e.target as Node)) setExportMenuOpen(false);
    }
    function onDocKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setExportMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    };
  }, [exportMenuOpen]);

  useEffect(() => {
    if (view !== 'assets') setAssetPreview(null);
  }, [view]);

  useEffect(() => {
    setAssetPreview(null);
  }, [slideId]);

  useEffect(() => {
    inspectActiveChangeRef.current?.(inspectActive);
    return () => {
      if (inspectActive) inspectActiveChangeRef.current?.(false);
    };
  }, [inspectActive]);

  useEffect(() => {
    pendingInspectEditsRef.current = pendingInspectEdits;
  }, [pendingInspectEdits]);

  useEffect(() => {
    redoStackRef.current = redoStack;
  }, [redoStack]);

  useEffect(() => {
    designDraftRef.current = designDraft;
  }, [designDraft]);

  useEffect(() => {
    if (!slideId) return;
    let cancelled = false;
    void Promise.all([
      fetchOpenSlideSource(projectId, slideId),
      fetchOpenSlideDesign(projectId, slideId),
      fetchOpenSlideModule(projectId, slideId),
    ]).then(([sourceResult, designResult, moduleResult]) => {
      if (cancelled) return;
      setSource(sourceResult?.source ?? null);
      const nextDesign = (designResult?.design as Record<string, any>) ?? null;
      setDesign(nextDesign);
      setDesignDraft(nextDesign ? cloneJsonObject(nextDesign) : null);
      setModuleCode(moduleResult?.code ?? null);
      setModuleDiagnostics(moduleResult?.diagnostics ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, slideId, file.mtime]);

  const queued = useMemo(
    () => feedback.filter((item) => item.slideId === slideId && item.status === 'queued'),
    [feedback, slideId],
  );
  const feedbackMarkers = useMemo(
    () => queued.flatMap((item, index) => (
      typeof item.line === 'number'
        ? [{
            id: item.id,
            line: item.line,
            column: item.column,
            note: item.note,
            pageIndex: item.pageIndex,
            index: index + 1,
          }]
        : []
    )),
    [queued],
  );

  function clearRedoStack() {
    redoStackRef.current = [];
    setRedoStack([]);
  }

  function pushRedoEntry(entry: OpenSlideRedoEntry) {
    const next = [...redoStackRef.current, entry];
    redoStackRef.current = next;
    setRedoStack(next);
  }

  function finishHistoryReplaySoon() {
    globalThis.setTimeout(() => {
      historyReplayRef.current = false;
    }, 0);
  }

  function clonePendingInspectEdit(edit: OpenSlidePendingBatchEdit): OpenSlidePendingBatchEdit {
    return {
      ...edit,
      ops: edit.ops.map((op) => ({ ...op })),
    };
  }

  function samePendingTarget(
    a: Pick<OpenSlidePendingBatchEdit, 'line' | 'column'>,
    b: Pick<OpenSlidePendingBatchEdit, 'line' | 'column'>,
  ) {
    return a.line === b.line && a.column === b.column;
  }

  function samePendingOpSlot(a: OpenSlidePendingEditOp, b: OpenSlidePendingEditOp) {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'set-style' && b.kind === 'set-style') return a.key === b.key;
    return a.kind === 'set-text' && b.kind === 'set-text';
  }

  function previousHistoryOpFor(entry: OpenSlidePendingBatchEdit, op: OpenSlidePendingEditOp): OpenSlidePendingEditOp | null {
    for (let index = undoInspectStackRef.current.length - 1; index >= 0; index -= 1) {
      const item = undoInspectStackRef.current[index];
      if (!item || !samePendingTarget(item, entry)) continue;
      const previous = item.ops.find((candidate) => samePendingOpSlot(candidate, op));
      if (previous) return { ...previous };
    }
    return null;
  }

  function removePendingInspectOp(
    current: OpenSlidePendingBatchEdit[],
    target: Pick<OpenSlidePendingBatchEdit, 'line' | 'column'>,
    op: OpenSlidePendingEditOp,
  ): OpenSlidePendingBatchEdit[] {
    const next = current.map((edit) => ({ ...edit, ops: [...edit.ops] }));
    const foundIndex = next.findIndex((edit) => samePendingTarget(edit, target));
    if (foundIndex < 0) return next;
    const found = next[foundIndex];
    if (!found) return next;
    found.ops = found.ops.filter((item) => !samePendingOpSlot(item, op));
    if (found.ops.length === 0) next.splice(foundIndex, 1);
    return next;
  }

  function applyUndoInspectEdit(entry: OpenSlidePendingBatchEdit) {
    let next = pendingInspectEditsRef.current.map((edit) => ({ ...edit, ops: [...edit.ops] }));
    const visualOps: OpenSlidePendingEditOp[] = [];
    for (const op of entry.ops) {
      const previous = previousHistoryOpFor(entry, op);
      if (previous) {
        visualOps.push(previous);
        next = upsertPendingInspectEdit(next, entry, [previous]);
      } else {
        visualOps.push(reversePendingInspectOp(op));
        next = removePendingInspectOp(next, entry, op);
      }
    }
    pendingInspectEditsRef.current = next;
    setPendingInspectEdits(next);
    applyInspectOpsToPreview(entry, visualOps);
  }

  function updateDesignDraft(pathName: string[], value: unknown) {
    clearRedoStack();
    setDesignDraft((current) => {
      const next = setDeepValue(current ?? design ?? {}, pathName, value);
      designDraftRef.current = next;
      return next;
    });
  }

  async function refreshSlideModule() {
    if (!slideId) return;
    const [nextSource, nextDesign, nextModule] = await Promise.all([
      fetchOpenSlideSource(projectId, slideId),
      fetchOpenSlideDesign(projectId, slideId),
      fetchOpenSlideModule(projectId, slideId),
    ]);
    setSource(nextSource?.source ?? source);
    if (nextDesign?.design) {
      const parsedDesign = nextDesign.design as Record<string, any>;
      setDesign(parsedDesign);
      setDesignDraft(cloneJsonObject(parsedDesign));
    }
    setModuleCode(nextModule?.code ?? moduleCode);
    setModuleDiagnostics(nextModule?.diagnostics ?? moduleDiagnostics);
  }

  async function createComment(applyImmediately = false) {
    if (!slideId || !commentText.trim() || (applyImmediately && agentBusy)) return;
    setSaving(true);
    try {
      const note = commentText.trim();
      const created = await createSlideFeedback(projectId, {
        kind: 'comment',
        slideId,
        conversationId,
        line: commentLine,
        column: commentColumn ?? undefined,
        pageIndex: activePageIndex,
        note,
        source: 'open-slide-inspector',
        targetLabel: selectedTarget?.targetLabel ?? file.name,
        payload: selectedTarget
          ? { hint: `Selected DOM source location ${selectedTarget.line}:${selectedTarget.column}` }
          : undefined,
      });
      if (!created) return;
      setCommentText('');
      setFeedbackDraftOpen(false);
      setCommentOpen(true);
      await onRefreshFeedback?.();
      if (applyImmediately) {
        onApplySlideFeedback?.(
          `请根据刚刚在 Open Slide 画布中选中的元素反馈修改当前 Web-PPT：${note}`,
          [feedbackToAttachment(created, 1)],
        );
      }
    } finally {
      setSaving(false);
    }
  }

  function selectInspectorTarget(target: OpenSlideSelectedTarget) {
    setSelectedTarget(target);
    setSelectedSnapshot(readOpenSlideElementSnapshot(target.anchor));
    setCommentLine(target.line);
    setCommentColumn(target.column);
    setCommentText('');
    setCommentOpen(false);
  }

  function handleSelectElement(target: OpenSlideSelectedTarget) {
    selectInspectorTarget(target);
    setFeedbackDraftOpen(false);
  }

  function handleRequestFeedback(target: OpenSlideSelectedTarget) {
    selectInspectorTarget(target);
    setFeedbackDraftOpen(true);
  }

  function upsertPendingInspectEdit(
    current: OpenSlidePendingBatchEdit[],
    target: Pick<OpenSlidePendingBatchEdit, 'line' | 'column' | 'pageIndex' | 'targetLabel'>,
    ops: OpenSlidePendingEditOp[],
  ): OpenSlidePendingBatchEdit[] {
      const next = current.map((edit) => ({
        ...edit,
        ops: [...edit.ops],
      }));
      const found = next.find((edit) => edit.line === target.line && edit.column === target.column);
      const nextOps = ops.map((op) => ({ ...op }));
      if (!found) {
        next.push({
          line: target.line,
          column: target.column,
          pageIndex: target.pageIndex ?? boundedPageIndex,
          targetLabel: target.targetLabel,
          ops: nextOps,
        });
        return next;
      }
      found.pageIndex = target.pageIndex ?? boundedPageIndex;
      found.targetLabel = target.targetLabel ?? found.targetLabel;
      for (const op of nextOps) {
        if (op.kind === 'set-style') {
          const existingIndex = found.ops.findIndex((item) => item.kind === 'set-style' && item.key === op.key);
          if (existingIndex >= 0) found.ops[existingIndex] = op;
          else found.ops.push(op);
        } else if (op.kind === 'set-text') {
          const existingIndex = found.ops.findIndex((item) => item.kind === 'set-text');
          if (existingIndex >= 0) found.ops[existingIndex] = op;
          else found.ops.push(op);
        }
      }
      return next;
  }

  function queueInspectOps(target: OpenSlideSelectedTarget, ops: OpenSlidePendingEditOp[]) {
    if (!historyReplayRef.current) {
      clearRedoStack();
      undoInspectStackRef.current = [
        ...undoInspectStackRef.current,
        clonePendingInspectEdit({
          line: target.line,
          column: target.column,
          pageIndex: boundedPageIndex,
          targetLabel: target.targetLabel,
          ops,
        }),
      ];
    }
    setPendingInspectEdits((current) => {
      const next = upsertPendingInspectEdit(current, {
        line: target.line,
        column: target.column,
        pageIndex: boundedPageIndex,
        targetLabel: target.targetLabel,
      }, ops);
      pendingInspectEditsRef.current = next;
      return next;
    });
  }

  function restorePendingInspectEdit(edit: OpenSlidePendingBatchEdit) {
    setPendingInspectEdits((current) => {
      const next = upsertPendingInspectEdit(current, edit, edit.ops);
      pendingInspectEditsRef.current = next;
      return next;
    });
    applyInspectOpsToPreview(edit, edit.ops);
  }

  function updateSelectedStyle(key: string, value: string | null) {
    if (!selectedTarget?.anchor) return;
    if (isOpenSlideStyleControlKey(key) && selectedSnapshot?.locks[key]) return;
    const style = selectedTarget.anchor.style as unknown as Record<string, string>;
    const prevValue = style[key] || null;
    style[key] = value ?? '';
    queueInspectOps(selectedTarget, [{ kind: 'set-style', key, value, prevValue }]);
    setSelectedSnapshot(readOpenSlideElementSnapshot(selectedTarget.anchor));
  }

  function updateSelectedTranslate(axis: 'x' | 'y', value: number) {
    if (!selectedTarget?.anchor || !selectedMoveEligibility.ok) return;
    const current = readOpenSlideTranslate(selectedTarget.anchor);
    const next = {
      x: axis === 'x' ? value : current.x,
      y: axis === 'y' ? value : current.y,
    };
    updateSelectedStyle('translate', formatOpenSlideTranslate(next.x, next.y));
  }

  function updateSelectedText(value: string) {
    if (!selectedTarget?.anchor) return;
    const prevText = selectedTarget.anchor.textContent ?? '';
    selectedTarget.anchor.textContent = value;
    queueInspectOps(selectedTarget, [{ kind: 'set-text', value, prevText }]);
    setSelectedSnapshot(readOpenSlideElementSnapshot(selectedTarget.anchor));
  }

  function handleMoveElement(target: OpenSlideSelectedTarget, ops: OpenSlidePendingEditOp[], anchor: HTMLElement) {
    queueInspectOps(target, ops);
    setSelectedTarget((current) => (
      current && current.line === target.line && current.column === target.column
        ? { ...current, anchor, targetLabel: summarizeSlideElement(anchor) }
        : current
    ));
    setSelectedSnapshot(readOpenSlideElementSnapshot(anchor));
  }

  function previewTargetForInspectEdit(edit: Pick<OpenSlidePendingBatchEdit, 'line' | 'column'>): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      `[data-inspector-root] [data-slide-loc="${edit.line}:${edit.column}"]`,
    );
  }

  function reversePendingInspectOp(op: OpenSlidePendingEditOp): OpenSlidePendingEditOp {
    if (op.kind === 'set-style') {
      return { ...op, value: op.prevValue ?? null };
    }
    return { ...op, value: op.prevText ?? '' };
  }

  function applyPendingOpToElement(el: HTMLElement, op: OpenSlidePendingEditOp) {
    if (op.kind === 'set-style') {
      const style = el.style as unknown as Record<string, string>;
      style[op.key] = op.value ?? '';
      return;
    }
    el.textContent = op.value;
  }

  function applyInspectOpsToPreview(
    edit: Pick<OpenSlidePendingBatchEdit, 'line' | 'column' | 'targetLabel'>,
    ops: OpenSlidePendingEditOp[],
  ) {
    const target = previewTargetForInspectEdit(edit);
    if (!target) return;
    for (const op of ops) applyPendingOpToElement(target, op);
    setSelectedTarget((current) => (
      current && current.line === edit.line && current.column === edit.column
        ? { ...current, anchor: target, targetLabel: summarizeSlideElement(target) }
        : current
    ));
    setSelectedSnapshot(readOpenSlideElementSnapshot(target));
  }

  function focusPendingEdit(edit: OpenSlidePendingBatchEdit) {
    const targetPage = clampNumber(edit.pageIndex ?? boundedPageIndex, 0, Math.max(0, pageCount - 1));
    setActivePageIndex(targetPage);
    setDesignOpen(false);
    setInspectActive(true);
    setFeedbackDraftOpen(false);
    setSelectedTarget({
      line: edit.line,
      column: edit.column,
      targetLabel: edit.targetLabel ?? file.name,
    });
  }

  function popLastPendingInspectEdit(): OpenSlidePendingBatchEdit | null {
    const next = pendingInspectEditsRef.current.map((edit) => ({ ...edit, ops: [...edit.ops] }));
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const edit = next[index];
      if (!edit || edit.ops.length === 0) continue;
      const lastOp = edit.ops[edit.ops.length - 1];
      if (!lastOp) continue;
      const removed = { ...edit, ops: [{ ...lastOp }] };
      edit.ops = edit.ops.slice(0, -1);
      if (edit.ops.length === 0) next.splice(index, 1);
      pendingInspectEditsRef.current = next;
      setPendingInspectEdits(next);
      return removed;
    }
    return null;
  }

  function styleLockLabel(reason: OpenSlideStyleLockReason | undefined): string | undefined {
    if (!reason) return undefined;
    if (reason === 'table-layout') return t('openSlide.lockedTableLayout');
    if (reason === 'inline-layout') return t('openSlide.lockedInlineLayout');
    if (reason === 'non-text-target') return t('openSlide.lockedNonText');
    return t('openSlide.lockedStructural');
  }

  function styleLockProps(key: OpenSlideStyleControlKey): { locked?: boolean; lockedReason?: string } {
    const reason = selectedSnapshot?.locks[key];
    return {
      locked: Boolean(reason),
      lockedReason: styleLockLabel(reason),
    };
  }

  function describeInspectSaveFailure(
    edit: OpenSlidePendingBatchEdit | undefined,
    index: number,
    error: string | undefined,
  ): string {
    const target = edit
      ? `${edit.targetLabel ?? t('openSlide.inspect')} (${edit.line}:${edit.column})`
      : `batch ${index + 1}`;
    return `${target}: ${error || 'could not apply edit'}`;
  }

  function failedInspectSaveMessages(
    edits: OpenSlidePendingBatchEdit[],
    results: Array<{ ok: boolean; error?: string }> | undefined,
  ): string[] {
    const failures = (results ?? [])
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => !result.ok);
    if (failures.length === 0) return [];
    return failures.map(({ result, index }) => describeInspectSaveFailure(edits[index], index, result.error));
  }

  function pendingEditsAfterInspectSaveFailure(
    edits: OpenSlidePendingBatchEdit[],
    result: { ok: boolean; results?: Array<{ ok: boolean; error?: string }> },
  ): OpenSlidePendingBatchEdit[] {
    const failed = (result.results ?? [])
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.ok);
    const hasGlobalFailure = !result.ok || failed.some(({ index }) => index >= edits.length);
    if (hasGlobalFailure) return edits;
    const failedIndices = new Set(failed.map(({ index }) => index));
    return edits.filter((_, index) => failedIndices.has(index));
  }

  const previewPages = useMemo(
    () => extractSlidePreviewPages(source, file.name, slideId),
    [file.name, slideId, source],
  );
  const runtime = useMemo(
    () => (slideId ? evaluateOpenSlideRuntime(moduleCode, projectId, slideId) : null),
    [moduleCode, projectId, slideId],
  );
  const runtimePages = runtime?.pages ?? [];
  const runtimeDesign = designDraft ?? design ?? runtime?.design ?? null;
  const palette = (runtimeDesign?.palette ?? {}) as Record<string, string>;
  const pageCount = runtimePages.length || previewPages.length;
  const boundedPageIndex = Math.min(activePageIndex, Math.max(0, pageCount - 1));
  const ActivePage = runtimePages[boundedPageIndex];
  const activePreview = previewPages[Math.min(boundedPageIndex, previewPages.length - 1)] ?? previewPages[0]!;
  const queuedAttachments = queued.map((item, index) => feedbackToAttachment(item, index + 1));
  const title = runtime?.meta?.title ?? previewPages[0]?.title ?? file.name;
  const hasRuntimePages = runtimePages.length > 0;
  const canPrev = boundedPageIndex > 0;
  const canNext = boundedPageIndex < pageCount - 1;
  const assetPrefix = slideId ? `slides/${slideId}/assets/` : '';
  const assetFiles = useMemo(
    () => files.filter((item) => assetPrefix && item.name.startsWith(assetPrefix)),
    [assetPrefix, files],
  );
  const sourcePreview = source ?? t('openSlide.loadingSource');
  const designDirty = JSON.stringify(designDraft ?? null) !== JSON.stringify(design ?? runtime?.design ?? null);
  const inspectDirtyCount = pendingInspectEdits.reduce((sum, edit) => sum + edit.ops.length, 0);
  const unsavedCount = (designDirty ? 1 : 0) + inspectDirtyCount;
  const canUndoWorkbench = !saving && unsavedCount > 0;
  const canRedoWorkbench = !saving && redoStack.length > 0;
  const panelOpen = designOpen || inspectActive;
  const selectedMoveEligibility = useMemo(
    () => openSlideMoveEligibilityForTarget(selectedTarget),
    [
      selectedTarget?.anchor,
      selectedTarget?.line,
      selectedTarget?.column,
      selectedSnapshot?.display,
      selectedSnapshot?.width,
      selectedSnapshot?.height,
      moduleCode,
      previewRevision,
    ],
  );
  const moveDisabledMessage = t(openSlideMoveDisabledCopyKey(selectedMoveEligibility.reason));

  async function commitWorkbenchChanges() {
    if (!slideId || unsavedCount === 0) return;
    const keepPage = boundedPageIndex;
    setSaving(true);
    try {
      if (designDirty && designDraft) {
        const next = await updateOpenSlideDesign(projectId, {
          slideId,
          patch: designDraft,
        });
        if (next?.design) {
          const parsedDesign = next.design as Record<string, any>;
          setDesign(parsedDesign);
          setDesignDraft(cloneJsonObject(parsedDesign));
        }
      }
      if (pendingInspectEdits.length > 0) {
        const attemptedInspectEdits = pendingInspectEdits.map(clonePendingInspectEdit);
        const result = await applyOpenSlideEdits(projectId, {
          slideId,
          edits: attemptedInspectEdits,
        });
        const failures = failedInspectSaveMessages(attemptedInspectEdits, result?.results);
        if (result?.ok && failures.length === 0) {
          pendingInspectEditsRef.current = [];
          undoInspectStackRef.current = [];
          setPendingInspectEdits([]);
        } else {
          const fallbackFailures = failures.length > 0 ? failures : ['Open Slide edit request failed'];
          const nextPending = result
            ? pendingEditsAfterInspectSaveFailure(attemptedInspectEdits, result)
            : attemptedInspectEdits;
          pendingInspectEditsRef.current = nextPending;
          undoInspectStackRef.current = nextPending.map(clonePendingInspectEdit);
          setPendingInspectEdits(nextPending);
          setModuleDiagnostics((current) => [
            ...fallbackFailures.map((message) => ({ message: `Save failed: ${message}` })),
            ...(current ?? []),
          ]);
        }
      }
      clearRedoStack();
      await refreshSlideModule();
      await onRefreshFiles?.();
      setActivePageIndex(keepPage);
    } finally {
      setSaving(false);
    }
  }

  async function handleOpenSlideExport(kind: OpenSlideExportKind) {
    if (!slideId || exportBusy) return;
    setExportMenuOpen(false);
    setExportBusy(kind);
    try {
      if (unsavedCount > 0) await commitWorkbenchChanges();
      await downloadOpenSlideExport(projectId, slideId, kind);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setModuleDiagnostics((current) => [
        { message: t('openSlide.exportFailed', { message }) },
        ...(current ?? []),
      ]);
    } finally {
      setExportBusy(null);
    }
  }

  function discardWorkbenchChanges() {
    const nextDesignDraft = design ? cloneJsonObject(design) : null;
    designDraftRef.current = nextDesignDraft;
    setDesignDraft(nextDesignDraft);
    pendingInspectEditsRef.current = [];
    undoInspectStackRef.current = [];
    setPendingInspectEdits([]);
    clearRedoStack();
    setPreviewRevision((value) => value + 1);
    setSelectedSnapshot(null);
  }

  function undoLastWorkbenchChange() {
    const currentInspectDirtyCount = pendingInspectEditsRef.current.reduce((sum, edit) => sum + edit.ops.length, 0);
    const currentDesignDraft = designDraftRef.current;
    const currentDesignDirty = JSON.stringify(currentDesignDraft ?? null) !== JSON.stringify(design ?? runtime?.design ?? null);
    if (saving || (currentInspectDirtyCount === 0 && undoInspectStackRef.current.length === 0 && !currentDesignDirty)) return;
    const historyEntry = undoInspectStackRef.current[undoInspectStackRef.current.length - 1];
    if (historyEntry) {
      historyReplayRef.current = true;
      const removed = clonePendingInspectEdit(historyEntry);
      undoInspectStackRef.current = undoInspectStackRef.current.slice(0, -1);
      applyUndoInspectEdit(removed);
      pushRedoEntry({ kind: 'inspect', edit: removed });
      focusPendingEdit(removed);
      setPreviewRevision((value) => value + 1);
      finishHistoryReplaySoon();
      return;
    }
    if (currentInspectDirtyCount > 0) {
      historyReplayRef.current = true;
      const removed = popLastPendingInspectEdit();
      if (removed) {
        pushRedoEntry({ kind: 'inspect', edit: removed });
        applyInspectOpsToPreview(removed, removed.ops.map(reversePendingInspectOp));
        focusPendingEdit(removed);
      }
      setPreviewRevision((value) => value + 1);
      finishHistoryReplaySoon();
      return;
    }
    if (currentDesignDirty) {
      pushRedoEntry({ kind: 'design', draft: currentDesignDraft ? cloneJsonObject(currentDesignDraft) : null });
      const nextDesignDraft = design ? cloneJsonObject(design) : null;
      designDraftRef.current = nextDesignDraft;
      setDesignDraft(nextDesignDraft);
      setPreviewRevision((value) => value + 1);
    }
  }

  function redoLastWorkbenchChange() {
    if (saving || redoStackRef.current.length === 0) return;
    const entry = redoStackRef.current[redoStackRef.current.length - 1];
    if (!entry) return;
    const nextRedoStack = redoStackRef.current.slice(0, -1);
    redoStackRef.current = nextRedoStack;
    setRedoStack(nextRedoStack);
    if (entry.kind === 'inspect') {
      historyReplayRef.current = true;
      undoInspectStackRef.current = [...undoInspectStackRef.current, clonePendingInspectEdit(entry.edit)];
      restorePendingInspectEdit(entry.edit);
      focusPendingEdit(entry.edit);
      setPreviewRevision((value) => value + 1);
      finishHistoryReplaySoon();
      return;
    }
    const nextDesignDraft = entry.draft ? cloneJsonObject(entry.draft) : null;
    designDraftRef.current = nextDesignDraft;
    setDesignDraft(nextDesignDraft);
    setPreviewRevision((value) => value + 1);
  }

  function applyQueuedFeedback() {
    if (queuedAttachments.length === 0 || agentBusy) return;
    setCommentOpen(false);
    onApplySlideFeedback?.(
      `请批量应用当前 ${queuedAttachments.length} 条暂存的 Open Slide 反馈，直接修改 slides/<slideId>/index.tsx 并保持其他页面不变。`,
      queuedAttachments,
    );
  }

  useEffect(() => {
    setActivePageIndex((curr) => Math.min(curr, Math.max(0, pageCount - 1)));
  }, [pageCount]);

  useEffect(() => {
    if (!inspectActive) setFeedbackDraftOpen(false);
  }, [inspectActive]);

  useEffect(() => {
    if (!inspectActive || !selectedTarget) return undefined;
    const timer = window.requestAnimationFrame(() => {
      const nextAnchor = document.querySelector<HTMLElement>(
        `[data-inspector-root] [data-slide-loc="${selectedTarget.line}:${selectedTarget.column}"]`,
      );
      if (!nextAnchor) return;
      setSelectedTarget((current) => (
        current && current.line === selectedTarget.line && current.column === selectedTarget.column
          ? { ...current, anchor: nextAnchor, targetLabel: summarizeSlideElement(nextAnchor) }
          : current
      ));
      setSelectedSnapshot(readOpenSlideElementSnapshot(nextAnchor));
    });
    return () => window.cancelAnimationFrame(timer);
  }, [inspectActive, selectedTarget?.line, selectedTarget?.column, moduleCode, boundedPageIndex, previewRevision]);

  useEffect(() => {
    const pageEdits = pendingInspectEdits.filter((edit) => (
      edit.pageIndex == null || edit.pageIndex === boundedPageIndex
    ));
    if (pageEdits.length === 0) return undefined;
    const timer = window.requestAnimationFrame(() => {
      for (const edit of pageEdits) {
        const target = document.querySelector<HTMLElement>(
          `[data-inspector-root] [data-slide-loc="${edit.line}:${edit.column}"]`,
        );
        if (!target) continue;
        for (const op of edit.ops) applyPendingOpToElement(target, op);
        if (selectedTarget?.line === edit.line && selectedTarget.column === edit.column) {
          setSelectedTarget((current) => (
            current && current.line === edit.line && current.column === edit.column
              ? { ...current, anchor: target, targetLabel: summarizeSlideElement(target) }
              : current
          ));
          setSelectedSnapshot(readOpenSlideElementSnapshot(target));
        }
      }
    });
    return () => window.cancelAnimationFrame(timer);
  }, [pendingInspectEdits, boundedPageIndex, moduleCode, previewRevision, selectedTarget?.line, selectedTarget?.column]);

  return (
    <div className="open-slide-pane">
      <div className="open-slide-shell">
        <header className="open-slide-topbar">
          <div className="open-slide-topbar-left">
            <span aria-hidden className="open-slide-topbar-divider" />
            <div className="open-slide-view-tabs" role="tablist" aria-label={t('openSlide.view')}>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'slides'}
                className={view === 'slides' ? 'active' : ''}
                onClick={() => setView('slides')}
              >
                <Icon name="grid" size={14} />
                {t('openSlide.slides')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'assets'}
                className={view === 'assets' ? 'active' : ''}
                onClick={() => setView('assets')}
              >
                <Icon name="folder" size={14} />
                {t('openSlide.assets')}
              </button>
            </div>
          </div>

          <div className="open-slide-inline-title" title={file.name}>
            <strong>{title}</strong>
            <span>{String(boundedPageIndex + 1).padStart(2, '0')} / {String(pageCount).padStart(2, '0')}</span>
          </div>

          <div className="open-slide-topbar-actions">
            {view === 'slides' ? (
              <>
                <button
                  type="button"
                  className={`open-slide-topbar-button ${designOpen ? 'active' : ''}`}
                  onClick={() => {
                    setDesignOpen((value) => {
                      const next = !value;
                      if (next) setInspectActive(false);
                      return next;
                    });
                  }}
                >
                  <Icon name="tweaks" size={14} />
                  <span>{t('openSlide.design')}</span>
                </button>
                <button
                  type="button"
                  className={`open-slide-topbar-button ${inspectActive ? 'active' : ''}`}
                  onClick={() => {
                    setInspectActive((value) => {
                      const next = !value;
                      if (next) setDesignOpen(false);
                      if (!next) setFeedbackDraftOpen(false);
                      return next;
                    });
                  }}
                >
                  <Icon name="pencil" size={14} />
                  <span>{t('openSlide.inspect')}</span>
                </button>
                <div className="share-menu open-slide-export-menu" ref={exportMenuRef}>
                  <button
                    type="button"
                    className={`open-slide-topbar-button ${exportMenuOpen ? 'active' : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={exportMenuOpen}
                    disabled={!slideId || Boolean(exportBusy)}
                    title={exportBusy ? t('openSlide.exporting') : t('openSlide.exportMenu')}
                    onClick={() => setExportMenuOpen((value) => !value)}
                  >
                    <Icon name={exportBusy ? 'spinner' : 'download'} size={14} />
                    <span>{exportBusy ? t('openSlide.exporting') : t('openSlide.export')}</span>
                    <Icon name="chevron-down" size={11} />
                  </button>
                  {exportMenuOpen ? (
                    <div className="share-menu-popover open-slide-export-popover" role="menu">
                      <button
                        type="button"
                        className="share-menu-item"
                        role="menuitem"
                        onClick={() => void handleOpenSlideExport('assets')}
                      >
                        <span className="share-menu-icon"><Icon name="file-code" size={14} /></span>
                        <span>{t('openSlide.exportHtmlPdfAssets')}</span>
                      </button>
                      <button
                        type="button"
                        className="share-menu-item"
                        role="menuitem"
                        onClick={() => void handleOpenSlideExport('pptx')}
                      >
                        <span className="share-menu-icon"><Icon name="present" size={14} /></span>
                        <span>{t('openSlide.exportPptxEditable')}</span>
                      </button>
                      <button
                        type="button"
                        className="share-menu-item"
                        role="menuitem"
                        onClick={() => void handleOpenSlideExport('pptx-raster')}
                      >
                        <span className="share-menu-icon"><Icon name="image" size={14} /></span>
                        <span>{t('openSlide.exportPptxRaster')}</span>
                      </button>
                    </div>
                  ) : null}
                </div>
                <span aria-hidden className="open-slide-topbar-divider" />
                <button
                  type="button"
                  className="open-slide-present-button"
                  disabled={!hasRuntimePages}
                  onClick={() => setPlaying(true)}
                >
                  <Icon name="play" size={14} />
                  <span>{t('openSlide.present')}</span>
                  <kbd>F</kbd>
                </button>
              </>
            ) : null}
          </div>
        </header>

        {view === 'assets' ? (
          <div className="open-slide-assets-view">
            <div className="open-slide-assets-card">
              <span className="open-slide-eyebrow">{t('openSlide.assets')}</span>
              <h3>{slideId ? `slides/${slideId}/assets` : t('openSlide.slideAssets')}</h3>
              {assetFiles.length === 0 ? (
                <p>{t('openSlide.assetsEmpty')}</p>
              ) : (
                <div className="open-slide-asset-grid">
                  {assetFiles.map((asset) => {
                    const assetUrl = projectRawUrl(projectId, asset.name);
                    const label = asset.name.replace(assetPrefix, '');
                    return (
                      <button
                        key={asset.name}
                        type="button"
                        className="open-slide-asset-card"
                        onClick={() => setAssetPreview(asset)}
                      >
                        {asset.kind === 'image' ? (
                          <img className="open-slide-asset-thumb" src={assetUrl} alt="" loading="lazy" />
                        ) : (
                          <Icon name="file" size={16} />
                        )}
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className={`open-slide-body ${panelOpen ? 'with-side-panel' : ''}`}>
            <aside className="open-slide-rail" aria-label={t('openSlide.slides')}>
              <div className="open-slide-rail-head">
                <span className="open-slide-eyebrow">{t('openSlide.pages')}</span>
                <span className="open-slide-folio">{String(pageCount).padStart(2, '0')}</span>
              </div>
              {Array.from({ length: pageCount }).map((_, index) => {
                const Page = runtimePages[index];
                const preview = previewPages[index] ?? previewPages[0]!;
                const active = index === boundedPageIndex;
                return (
                  <OpenSlidePreviewSelectShell
                    key={`${preview.title}-${index}`}
                    className="open-slide-thumb-item"
                    hitClassName="open-slide-thumb-hit-target"
                    active={active}
                    onSelect={() => setActivePageIndex(index)}
                    label={preview.title}
                    title={preview.title}
                  >
                    <span className="open-slide-thumb-number">{String(index + 1).padStart(2, '0')}</span>
                    <div className="open-slide-thumb" {...OPEN_SLIDE_INERT_PREVIEW_PROPS}>
                      {Page ? (
                        <OpenSlideCanvas scale={184 / 1920} center={false} flat freezeMotion design={runtimeDesign}>
                          <OpenSlideRuntimeBoundary resetKey={`thumb-${index}-${moduleCode?.length ?? 0}`} renderFailedLabel={t('openSlide.renderFailed')}>
                            <OpenSlideRuntimePageView page={Page} design={runtimeDesign} />
                          </OpenSlideRuntimeBoundary>
                        </OpenSlideCanvas>
                      ) : (
                        <div className="open-slide-thumb-fallback">
                          <strong>{preview.kicker}</strong>
                          <em>{preview.title}</em>
                        </div>
                      )}
                      {active ? <span aria-hidden className="open-slide-thumb-active" /> : null}
                    </div>
                  </OpenSlidePreviewSelectShell>
                );
              })}
            </aside>

            <main className="open-slide-paper" data-inspector-root>
              <button
                type="button"
                className="open-slide-click-zone prev"
                aria-label={t('openSlide.player.previous')}
                disabled={!canPrev || inspectActive}
                title={t('openSlide.player.previous')}
                onClick={() => setActivePageIndex((index) => Math.max(0, index - 1))}
              />
              <button
                type="button"
                className="open-slide-click-zone next"
                aria-label={t('openSlide.player.next')}
                disabled={!canNext || inspectActive}
                title={t('openSlide.player.next')}
                onClick={() => setActivePageIndex((index) => Math.min(pageCount - 1, index + 1))}
              />
              <OpenSlideCanvas
                key={`main-${boundedPageIndex}-${moduleCode?.length ?? 0}-${previewRevision}`}
                design={runtimeDesign}
                inspectActive={inspectActive && Boolean(ActivePage)}
                moveEditing={inspectActive}
                moveEnabled={selectedMoveEligibility.ok}
                selected={selectedTarget}
                feedbackMarkers={feedbackMarkers}
                feedbackDraft={
                  feedbackDraftOpen && selectedTarget
                    ? {
                        text: commentText,
                        saving,
                        triggerDisabled: agentBusy,
                        onChange: setCommentText,
                        onQueue: () => void createComment(false),
                        onTrigger: () => void createComment(true),
                        onClose: () => {
                          setCommentText('');
                          setFeedbackDraftOpen(false);
                        },
                      }
                    : null
                }
                onSelectElement={handleSelectElement}
                onRequestFeedback={handleRequestFeedback}
                onMoveElement={handleMoveElement}
              >
                {ActivePage ? (
                  <OpenSlideRuntimeBoundary
                    key={`page-${boundedPageIndex}-${moduleCode?.length ?? 0}-${previewRevision}`}
                    resetKey={`page-${boundedPageIndex}-${moduleCode?.length ?? 0}-${previewRevision}`}
                    renderFailedLabel={t('openSlide.renderFailed')}
                  >
                    <OpenSlideRuntimePageView page={ActivePage} design={runtimeDesign} />
                  </OpenSlideRuntimeBoundary>
                ) : (
                  <OpenSlideFallbackPreview page={activePreview} palette={palette} />
                )}
              </OpenSlideCanvas>
              {runtime?.error || moduleDiagnostics?.length ? (
                <div className="open-slide-runtime-banner">
                  <strong>{runtime?.error ?? t('openSlide.typeScriptDiagnostics')}</strong>
                  {moduleDiagnostics?.length ? (
                    <span>{moduleDiagnostics.map((diagnostic) => diagnostic.message).join(' · ')}</span>
                  ) : null}
                </div>
              ) : null}
              <div className={`open-slide-savebar ${unsavedCount > 0 ? 'dirty' : ''}`}>
                <button
                  type="button"
                  className={`icon ${canUndoWorkbench ? 'available' : ''}`}
                  disabled={!canUndoWorkbench}
                  aria-label={t('openSlide.undo')}
                  title={t('openSlide.undo')}
                  onClick={undoLastWorkbenchChange}
                >
                  <Icon name="undo" size={16} />
                </button>
                <button
                  type="button"
                  className={`icon ${canRedoWorkbench ? 'available' : ''}`}
                  disabled={!canRedoWorkbench}
                  aria-label={t('openSlide.redo')}
                  title={t('openSlide.redo')}
                  onClick={redoLastWorkbenchChange}
                >
                  <Icon name="redo" size={16} />
                </button>
                <span aria-hidden className="open-slide-savebar-sep" />
                <span className="open-slide-savebar-state">
                  {saving ? <Icon name="spinner" size={14} /> : <span aria-hidden className="dot" />}
                  {unsavedCount > 0
                    ? t(unsavedCount === 1 ? 'openSlide.unsavedOne' : 'openSlide.unsavedMany', { count: unsavedCount })
                    : canRedoWorkbench
                      ? t('openSlide.redoAvailable')
                    : panelOpen
                      ? (inspectActive && !selectedTarget ? t('openSlide.selectElement') : t('openSlide.unsavedZero'))
                      : t('openSlide.ready')}
                </span>
                {unsavedCount > 0 ? (
                  <>
                    <button type="button" className="ghost" disabled={saving} onClick={discardWorkbenchChanges}>
                      {t('openSlide.discard')}
                    </button>
                    <button type="button" className="primary" disabled={saving} onClick={() => void commitWorkbenchChanges()}>
                      {saving ? t('openSlide.saving') : t('common.save')}
                    </button>
                  </>
                ) : null}
              </div>
              <div className={`open-slide-comment-widget ${commentOpen ? 'is-open' : ''}`}>
                {commentOpen ? (
                  <div className="open-slide-comment-popover">
                    <div className="open-slide-comment-head">
                      <strong>{t(queued.length === 1 ? 'openSlide.queuedOne' : 'openSlide.queuedMany', { count: queued.length })}</strong>
                      <button type="button" onClick={() => setCommentOpen(false)} aria-label={t('openSlide.comments.close')}>
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                    {queued.length === 0 ? (
                      <p>{t('openSlide.comments.empty')}</p>
                    ) : (
                      <ul>
                        {queued.map((item, index) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => {
                                if (typeof item.pageIndex === 'number') {
                                  setActivePageIndex(clampNumber(item.pageIndex, 0, Math.max(0, pageCount - 1)));
                                }
                                setCommentOpen(false);
                              }}
                            >
                              <span className="open-slide-comment-index">{index + 1}</span>
                              <span className="open-slide-comment-copy">
                                <em>
                                  {t('openSlide.pageLine', {
                                    page: typeof item.pageIndex === 'number' ? item.pageIndex + 1 : boundedPageIndex + 1,
                                    line: typeof item.line === 'number' ? item.line : '-',
                                  })}
                                </em>
                                <strong>{item.note}</strong>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      disabled={queuedAttachments.length === 0 || saving || agentBusy}
                      onClick={applyQueuedFeedback}
                    >
                      {t('openSlide.applyQueued')}
                    </button>
                  </div>
                ) : null}
                <button type="button" onClick={() => setCommentOpen((value) => !value)}>
                  <Icon name="comment" size={16} />
                  {queued.length}
                </button>
              </div>
            </main>

            <div className="open-slide-mobile-rail" aria-label={t('openSlide.slides')}>
              {Array.from({ length: pageCount }).map((_, index) => {
                const Page = runtimePages[index];
                const preview = previewPages[index] ?? previewPages[0]!;
                const active = index === boundedPageIndex;
                return (
                  <OpenSlidePreviewSelectShell
                    // biome-ignore lint/suspicious/noArrayIndexKey: page order is stable inside a loaded module
                    key={index}
                    className="open-slide-mobile-thumb"
                    hitClassName="open-slide-mobile-thumb-hit-target"
                    active={active}
                    onSelect={() => setActivePageIndex(index)}
                    label={preview.title}
                  >
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <div className="open-slide-mobile-thumb-preview" {...OPEN_SLIDE_INERT_PREVIEW_PROPS}>
                      {Page ? (
                        <OpenSlideCanvas scale={64 / 1080} center={false} flat freezeMotion design={runtimeDesign}>
                          <OpenSlideRuntimeBoundary resetKey={`mobile-thumb-${index}`} renderFailedLabel={t('openSlide.renderFailed')}>
                            <OpenSlideRuntimePageView page={Page} design={runtimeDesign} />
                          </OpenSlideRuntimeBoundary>
                        </OpenSlideCanvas>
                      ) : null}
                    </div>
                  </OpenSlidePreviewSelectShell>
                );
              })}
            </div>

            {inspectActive ? (
              <aside className="open-slide-side-panel open-slide-inspector">
                <div className="open-slide-panel-head">
                  <div>
                    <Icon name="target" size={14} />
                    <strong>{t('openSlide.inspector')}</strong>
                  </div>
                  <button type="button" onClick={() => setInspectActive(false)} aria-label={t('openSlide.inspector.close')}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <section className={`open-slide-selected-card ${selectedTarget ? '' : 'muted'}`}>
                  <h3><Icon name="target" size={13} />{t('openSlide.selection')}</h3>
                  {selectedTarget ? (
                    <>
                      <div className="open-slide-selection-summary">
                        <strong title={selectedTarget.targetLabel}>
                          {abbreviateSelectionLabel(selectedTarget.targetLabel)}
                        </strong>
                      </div>
                      <span className="open-slide-selection-meta">
                        &lt;{selectedSnapshot?.tagName ?? 'element'}&gt; · {selectedTarget.line}:{selectedTarget.column}
                        {selectedSnapshot ? (
                          <> · {Math.round(selectedSnapshot.width)}×{Math.round(selectedSnapshot.height)}</>
                        ) : null}
                      </span>
                    </>
                  ) : (
                    <span>{t('openSlide.selectionHint')}</span>
                  )}
                </section>
                {selectedTarget && selectedSnapshot ? (
                  <>
                    {selectedSnapshot.text !== null ? (
                      <section>
                        <h3><Icon name="text" size={13} />{t('openSlide.content')}</h3>
                        <textarea
                          className="open-slide-content-textarea"
                          value={selectedSnapshot.text}
                          onChange={(event) => updateSelectedText(event.target.value)}
                        />
                      </section>
                    ) : null}
                    <section>
                      <h3><Icon name="layout" size={13} />{t('openSlide.positionSize')}</h3>
                      <div className={`open-slide-move-status ${selectedMoveEligibility.ok ? '' : 'blocked'}`}>
                        <p>
                          <Icon name="move" size={13} />
                          {selectedMoveEligibility.ok
                            ? t('openSlide.moveReady')
                            : moveDisabledMessage}
                        </p>
                      </div>
                      <OpenSlideRangeField
                        label={t('openSlide.positionX')}
                        value={Math.round(selectedSnapshot.translateX)}
                        min={-1920}
                        max={1920}
                        suffix={t('openSlide.unitPx')}
                        locked={!selectedMoveEligibility.ok}
                        lockedReason={moveDisabledMessage}
                        onChange={(value) => updateSelectedTranslate('x', Math.round(value))}
                      />
                      <OpenSlideRangeField
                        label={t('openSlide.positionY')}
                        value={Math.round(selectedSnapshot.translateY)}
                        min={-1080}
                        max={1080}
                        suffix={t('openSlide.unitPx')}
                        locked={!selectedMoveEligibility.ok}
                        lockedReason={moveDisabledMessage}
                        onChange={(value) => updateSelectedTranslate('y', Math.round(value))}
                      />
                      <OpenSlideRangeField
                        label={t('openSlide.width')}
                        value={Math.round(selectedSnapshot.width)}
                        min={12}
                        max={1920}
                        suffix={t('openSlide.unitPx')}
                        {...styleLockProps('width')}
                        onChange={(value) => updateSelectedStyle('width', `${Math.round(value)}px`)}
                      />
                      <OpenSlideRangeField
                        label={t('openSlide.height')}
                        value={Math.round(selectedSnapshot.height)}
                        min={12}
                        max={1080}
                        suffix={t('openSlide.unitPx')}
                        {...styleLockProps('height')}
                        onChange={(value) => updateSelectedStyle('height', `${Math.round(value)}px`)}
                      />
                      <OpenSlideRangeField
                        label={t('openSlide.opacity')}
                        value={Math.round(selectedSnapshot.opacity * 100)}
                        min={0}
                        max={100}
                        suffix="%"
                        {...styleLockProps('opacity')}
                        onChange={(value) => updateSelectedStyle('opacity', String(Math.max(0, Math.min(1, value / 100))))}
                      />
                      <OpenSlideRangeField
                        label={t('openSlide.radius')}
                        value={Math.round(selectedSnapshot.borderRadius)}
                        min={0}
                        max={120}
                        suffix={t('openSlide.unitPx')}
                        {...styleLockProps('borderRadius')}
                        onChange={(value) => updateSelectedStyle('borderRadius', `${Math.round(value)}px`)}
                      />
                    </section>
                    <section>
                      <h3><Icon name="text" size={13} />{t('openSlide.typography')}</h3>
                      <OpenSlideRangeField
                        label={t('openSlide.size')}
                        value={Math.round(selectedSnapshot.fontSize)}
                        min={8}
                        max={220}
                        suffix={t('openSlide.unitPx')}
                        {...styleLockProps('fontSize')}
                        onChange={(value) => updateSelectedStyle('fontSize', `${Math.round(value)}px`)}
                      />
                      <OpenSlideSelectField
                        label={t('openSlide.weight')}
                        value={String(Math.round(selectedSnapshot.fontWeight))}
                        options={[
                          ['300', t('openSlide.weightLight')],
                          ['400', t('openSlide.weightRegular')],
                          ['500', t('openSlide.weightMedium')],
                          ['600', t('openSlide.weightSemibold')],
                          ['700', t('openSlide.weightBold')],
                          ['800', t('openSlide.weightExtra')],
                        ]}
                        {...styleLockProps('fontWeight')}
                        onChange={(value) => updateSelectedStyle('fontWeight', value)}
                      />
                      <OpenSlideField label={t('openSlide.style')}>
                        <div className="open-slide-segmented compact">
                          <button
                            type="button"
                            className={selectedSnapshot.fontWeight >= 600 ? 'active' : ''}
                            disabled={Boolean(selectedSnapshot.locks.fontWeight)}
                            onClick={() => updateSelectedStyle('fontWeight', selectedSnapshot.fontWeight >= 600 ? '400' : '700')}
                            title={styleLockLabel(selectedSnapshot.locks.fontWeight) ?? t('openSlide.bold')}
                          >
                            B
                          </button>
                          <button
                            type="button"
                            className={selectedSnapshot.fontStyle === 'italic' ? 'active' : ''}
                            disabled={Boolean(selectedSnapshot.locks.fontStyle)}
                            onClick={() => updateSelectedStyle('fontStyle', selectedSnapshot.fontStyle === 'italic' ? null : 'italic')}
                            title={styleLockLabel(selectedSnapshot.locks.fontStyle) ?? t('openSlide.italic')}
                          >
                            <em>I</em>
                          </button>
                        </div>
                      </OpenSlideField>
                      <OpenSlideRangeField
                        label={t('openSlide.lineHeight')}
                        value={Number(selectedSnapshot.lineHeight.toFixed(2))}
                        min={0.8}
                        max={3}
                        step={0.05}
                        {...styleLockProps('lineHeight')}
                        onChange={(value) => updateSelectedStyle('lineHeight', String(Number(value.toFixed(2))))}
                      />
                      <OpenSlideRangeField
                        label={t('openSlide.tracking')}
                        value={Number(selectedSnapshot.letterSpacing.toFixed(1))}
                        min={-8}
                        max={32}
                        step={0.1}
                        suffix={t('openSlide.unitPx')}
                        {...styleLockProps('letterSpacing')}
                        onChange={(value) => updateSelectedStyle('letterSpacing', `${Number(value.toFixed(1))}px`)}
                      />
                      <OpenSlideField label={t('openSlide.align')} {...styleLockProps('textAlign')}>
                        <div className="open-slide-segmented">
                          {OPEN_SLIDE_TEXT_ALIGN_OPTIONS.map(({ value: align, icon, labelKey }) => (
                            <button
                              key={align}
                              type="button"
                              className={selectedSnapshot.textAlign === align ? 'active' : ''}
                              disabled={Boolean(selectedSnapshot.locks.textAlign)}
                              aria-label={t(labelKey)}
                              title={styleLockLabel(selectedSnapshot.locks.textAlign) ?? t(labelKey)}
                              onClick={() => updateSelectedStyle('textAlign', align === 'left' ? null : align)}
                            >
                              <Icon name={icon} size={17} strokeWidth={1.9} />
                            </button>
                          ))}
                        </div>
                      </OpenSlideField>
                    </section>
                    <section>
                      <h3><Icon name="tweaks" size={13} />{t('openSlide.color')}</h3>
                      <OpenSlideColorField
                        label={t('openSlide.text')}
                        value={selectedSnapshot.color}
                        {...styleLockProps('color')}
                        onChange={(value) => updateSelectedStyle('color', value)}
                      />
                      <OpenSlideColorField
                        label={t('openSlide.background')}
                        value={selectedSnapshot.backgroundColor ?? '#ffffff'}
                        clearable
                        dim={!selectedSnapshot.backgroundColor}
                        {...styleLockProps('backgroundColor')}
                        onChange={(value) => updateSelectedStyle('backgroundColor', value)}
                        onClear={() => updateSelectedStyle('backgroundColor', null)}
                      />
                    </section>
                  </>
                ) : null}
                <details className="open-slide-source-details">
                  <summary>{t('openSlide.source')}</summary>
                  <pre>{sourcePreview}</pre>
                </details>
              </aside>
            ) : null}

            {designOpen ? (
              <aside className="open-slide-side-panel open-slide-design-panel">
	                <div className="open-slide-panel-head">
	                  <div>
	                    <Icon name="tweaks" size={14} />
	                    <strong>{t('openSlide.designTokens')}</strong>
                  </div>
                  <button type="button" onClick={() => setDesignOpen(false)} aria-label={t('openSlide.design.close')}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <section>
                  <h3>{t('openSlide.colors')}</h3>
                  <OpenSlideColorField
                    label={t('openSlide.background')}
                    value={palette.bg ?? '#0f172a'}
                    onChange={(value) => updateDesignDraft(['palette', 'bg'], value)}
                  />
                  <OpenSlideColorField
                    label={t('openSlide.text')}
                    value={palette.text ?? '#f8fafc'}
                    onChange={(value) => updateDesignDraft(['palette', 'text'], value)}
                  />
                  <OpenSlideColorField
                    label={t('openSlide.accent')}
                    value={palette.accent ?? '#38bdf8'}
                    onChange={(value) => updateDesignDraft(['palette', 'accent'], value)}
                  />
                </section>
                <section>
                  <h3>{t('openSlide.typography')}</h3>
                  <OpenSlideSelectField
                    label={t('openSlide.display')}
                    value={String((runtimeDesign?.fonts as Record<string, string> | undefined)?.display ?? '')}
                    options={[
                      ['system-ui, -apple-system, BlinkMacSystemFont, "Inter", sans-serif', 'System sans'],
                      ['"Inter", system-ui, sans-serif', 'Inter'],
                      ['"Helvetica Neue", Helvetica, Arial, sans-serif', 'Helvetica'],
                      ['Georgia, "Times New Roman", serif', 'Georgia'],
                      ['Geist Mono, ui-monospace, "SFMono-Regular", monospace', 'Geist Mono'],
                    ]}
                    onChange={(value) => updateDesignDraft(['fonts', 'display'], value)}
                  />
                  <OpenSlideSelectField
                    label={t('openSlide.body')}
                    value={String((runtimeDesign?.fonts as Record<string, string> | undefined)?.body ?? '')}
                    options={[
                      ['system-ui, -apple-system, BlinkMacSystemFont, "Inter", sans-serif', 'System sans'],
                      ['"Inter", system-ui, sans-serif', 'Inter'],
                      ['"Helvetica Neue", Helvetica, Arial, sans-serif', 'Helvetica'],
                      ['Georgia, "Times New Roman", serif', 'Georgia'],
                      ['Geist Mono, ui-monospace, "SFMono-Regular", monospace', 'Geist Mono'],
                    ]}
                    onChange={(value) => updateDesignDraft(['fonts', 'body'], value)}
                  />
                  <OpenSlideRangeField
                    label={t('openSlide.hero')}
                    value={Number((runtimeDesign?.typeScale as Record<string, unknown> | undefined)?.hero ?? 156)}
                    min={48}
                    max={240}
                    step={2}
                    suffix={t('openSlide.unitPx')}
                    onChange={(value) => updateDesignDraft(['typeScale', 'hero'], Math.round(value))}
                  />
                  <OpenSlideRangeField
                    label={t('openSlide.body')}
                    value={Number((runtimeDesign?.typeScale as Record<string, unknown> | undefined)?.body ?? 38)}
                    min={12}
                    max={76}
                    suffix={t('openSlide.unitPx')}
                    onChange={(value) => updateDesignDraft(['typeScale', 'body'], Math.round(value))}
                  />
                </section>
                <section>
                  <h3>{t('openSlide.shape')}</h3>
                  <OpenSlideRangeField
                    label={t('openSlide.radius')}
                    value={Number(runtimeDesign?.radius ?? 12)}
                    min={0}
                    max={80}
                    suffix={t('openSlide.unitPx')}
                    onChange={(value) => updateDesignDraft(['radius'], Math.round(value))}
                  />
                </section>
              </aside>
            ) : null}
          </div>
        )}
      </div>
      {assetPreview ? (
        <OpenSlideAssetPreviewDialog
          projectId={projectId}
          asset={assetPreview}
          label={assetPreview.name.replace(assetPrefix, '')}
          onClose={() => setAssetPreview(null)}
        />
      ) : null}
      {playing && runtimePages.length > 0 ? (
        <OpenSlidePlayerOverlay
          pages={runtimePages}
          design={runtimeDesign}
          activeIndex={boundedPageIndex}
          onSelect={setActivePageIndex}
          onClose={() => setPlaying(false)}
        />
      ) : null}
    </div>
  );
}

export function OpenSlideAssetPreviewDialog({
  projectId,
  asset,
  label,
  onClose,
}: {
  projectId: string;
  asset: ProjectFile;
  label: string;
  onClose: () => void;
}) {
  const t = useT();
  const assetUrl = projectRawUrl(projectId, asset.name);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function onBackdropMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="open-slide-asset-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="open-slide-asset-preview-shell">
        <header className="open-slide-asset-preview-topbar">
          <div className="open-slide-asset-preview-title">
            <Icon name={asset.kind === 'image' ? 'image' : 'file'} size={15} />
            <span>{label}</span>
          </div>
          <div className="open-slide-asset-preview-actions">
            <a
              className="open-slide-asset-preview-action"
              href={assetUrl}
              download={label}
              title={t('fileViewer.download')}
              aria-label={t('fileViewer.download')}
            >
              <Icon name="download" size={14} />
              <span>{t('fileViewer.download')}</span>
            </a>
            <a
              className="open-slide-asset-preview-action"
              href={assetUrl}
              target="_blank"
              rel="noreferrer"
              title={t('preview.openInNewTab')}
              aria-label={t('preview.openInNewTab')}
            >
              <Icon name="external-link" size={14} />
              <span>{t('preview.openInNewTab')}</span>
            </a>
            <button
              type="button"
              className="open-slide-asset-preview-close"
              onClick={onClose}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </header>
        <div className="open-slide-asset-preview-stage">
          {asset.kind === 'image' ? (
            <img src={assetUrl} alt={label} />
          ) : asset.kind === 'video' ? (
            <video src={assetUrl} controls />
          ) : asset.kind === 'audio' ? (
            <audio src={assetUrl} controls />
          ) : asset.kind === 'html' ? (
            <iframe src={assetUrl} title={label} sandbox="allow-scripts" />
          ) : (
            <div className="open-slide-asset-preview-file">
              <Icon name="file" size={28} />
              <span>{label}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OpenSlideField({
  label,
  children,
  className,
  locked = false,
  lockedReason,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  locked?: boolean;
  lockedReason?: string;
}) {
  const t = useT();
  return (
    <label
      className={['open-slide-editor-field', locked ? 'is-locked' : '', className ?? ''].filter(Boolean).join(' ')}
      title={locked ? lockedReason : undefined}
    >
      <span className="open-slide-field-label">
        <span>{label}</span>
        {locked ? (
          <span className="open-slide-lock-badge">
            <Icon name="lock" size={11} />
            {t('openSlide.locked')}
          </span>
        ) : null}
      </span>
      <div className="open-slide-field-controls">{children}</div>
    </label>
  );
}

function OpenSlideRangeField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  locked = false,
  lockedReason,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  locked?: boolean;
  lockedReason?: string;
  onChange: (value: number) => void;
}) {
  const safeValue = Number.isFinite(value) ? value : min;
  const rangeFill = max > min
    ? `${Math.max(0, Math.min(100, ((safeValue - min) / (max - min)) * 100))}%`
    : '0%';
  return (
    <OpenSlideField label={label} className="open-slide-range-field" locked={locked} lockedReason={lockedReason}>
      <span className="open-slide-range-track-wrap">
        <input
          aria-label={label}
          disabled={locked}
          type="range"
          min={min}
          max={max}
          step={step}
          value={safeValue}
          style={{ '--range-fill': rangeFill } as React.CSSProperties}
          onChange={(event) => {
            if (!locked) onChange(Number(event.target.value));
          }}
        />
      </span>
      <span className="open-slide-number-input">
        <input
          type="number"
          disabled={locked}
          min={min}
          max={max}
          step={step}
          value={safeValue}
          onChange={(event) => {
            if (!locked) onChange(Number(event.target.value));
          }}
        />
        {suffix ? <em>{suffix}</em> : null}
      </span>
    </OpenSlideField>
  );
}

function OpenSlideColorField({
  label,
  value,
  onChange,
  onClear,
  clearable = false,
  dim = false,
  locked = false,
  lockedReason,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  clearable?: boolean;
  dim?: boolean;
  locked?: boolean;
  lockedReason?: string;
}) {
  const [draft, setDraft] = useState(value);
  const t = useT();
  useEffect(() => setDraft(value), [value]);
  return (
    <OpenSlideField label={label} className="open-slide-color-field" locked={locked} lockedReason={lockedReason}>
      <label className={`open-slide-color-chip ${dim ? 'transparent' : ''}`}>
        <span style={{ background: dim ? 'transparent' : value }} />
        <input
          type="color"
          disabled={locked}
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'}
          onChange={(event) => {
            if (locked) return;
            setDraft(event.target.value);
            onChange(event.target.value);
          }}
        />
      </label>
      <input
        className="open-slide-hex-input"
        disabled={locked}
        value={draft}
        spellCheck={false}
        onChange={(event) => {
          if (locked) return;
          const next = event.target.value;
          setDraft(next);
          if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next);
        }}
      />
      {clearable ? (
        <button
          type="button"
          className="open-slide-clear-button"
          disabled={locked}
          onClick={onClear}
          aria-label={t('openSlide.clearField', { label })}
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </OpenSlideField>
  );
}

function OpenSlideSelectField({
  label,
  value,
  options,
  locked = false,
  lockedReason,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  locked?: boolean;
  lockedReason?: string;
  onChange: (value: string) => void;
}) {
  const selectedValue = options.some(([option]) => option === value) ? value : options[0]?.[0] ?? '';
  return (
    <OpenSlideField label={label} locked={locked} lockedReason={lockedReason}>
      <select
        className="open-slide-select"
        disabled={locked}
        value={selectedValue}
        onChange={(event) => {
          if (!locked) onChange(event.target.value);
        }}
      >
        {options.map(([option, text]) => (
          <option key={option} value={option}>{text}</option>
        ))}
      </select>
    </OpenSlideField>
  );
}

function Tab({
  label,
  active,
  onActivate,
  onClose,
  closable = true,
  kind,
  liveArtifact,
}: {
  label: string;
  active: boolean;
  onActivate: () => void;
  onClose?: () => void;
  closable?: boolean;
  kind?: ProjectFile['kind'] | 'live-artifact';
  liveArtifact?: LiveArtifactWorkspaceEntry;
}) {
  const t = useT();
  const iconName = kindIconName(kind);
  return (
    <div
      className={`ws-tab ${active ? 'active' : ''}`}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      role="tab"
      aria-selected={active}
      tabIndex={0}
    >
      {iconName ? (
        <span className="tab-icon" aria-hidden>
          <Icon name={iconName} size={13} />
        </span>
      ) : null}
      <span className="ws-tab-label">{label}</span>
      {liveArtifact ? (
        <LiveArtifactBadges
          compact
          className="ws-live-artifact-badges"
          status={liveArtifact.status}
          refreshStatus={liveArtifact.refreshStatus}
        />
      ) : null}
      {closable && onClose ? (
        <button
          type="button"
          className="ws-tab-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={t('workspace.closeTab')}
        >
          <Icon name="close" size={11} />
        </button>
      ) : null}
    </div>
  );
}

function kindIconName(
  kind?: string,
):
  | 'file-code'
  | 'image'
  | 'pencil'
  | 'present'
  | 'file'
  | null {
  if (kind === 'live-artifact') return 'file-code';
  if (kind === 'presentation') return 'present';
  if (kind === 'html') return 'file-code';
  if (kind === 'image') return 'image';
  if (kind === 'sketch') return 'pencil';
  if (kind === 'code') return 'file-code';
  if (kind === 'text') return 'file';
  return 'file';
}

function isSketchName(name: string): boolean {
  return name.endsWith('.sketch.json');
}

function isOpenPptSlideFile(name: string): boolean {
  return /^slides\/[^/]+\/index\.tsx$/.test(name);
}

function slideIdFromPath(name: string): string | null {
  return name.match(/^slides\/([^/]+)\/index\.tsx$/)?.[1] ?? null;
}

function isLiveArtifactImplementationPath(name: string): boolean {
  if (name === '.live-artifacts') return true;
  if (!name.startsWith('.live-artifacts/')) return false;
  // Live artifacts are exposed through virtual tree nodes only. In
  // particular, keep implementation-only snapshot and tile files hidden even
  // if a generic project-files endpoint returns them in older daemon builds.
  return true;
}

function parseSketchDocument(text: string | null): SketchItem[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as SketchDocument | { items?: SketchItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}
