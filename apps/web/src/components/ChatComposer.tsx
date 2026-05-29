import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { fetchVaultDesigns, projectRawUrl, uploadProjectFiles, openFolderDialog } from "../providers/registry";
import { patchProject } from "../state/projects";
import type { ChatAttachment, ChatCommentAttachment, ChatVaultContextAttachment, ProjectFile, ProjectMetadata, VaultDesignMeta } from "../types";
import { vaultTemplateCoverPreviewSource } from "../utils/vaultPreview";
import { Icon } from "./Icon";
import { VaultPreviewFrame } from "./VaultPreviewFrame";

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

interface Props {
  projectId: string | null;
  projectFiles: ProjectFile[];
  streaming: boolean;
  initialDraft?: string;
  // Lazy ensure — the composer calls this before its first upload, so the
  // project folder exists on disk before files land in it. Returns the
  // project id when ready.
  onEnsureProject: () => Promise<string | null>;
  commentAttachments?: ChatCommentAttachment[];
  onRemoveCommentAttachment?: (id: string) => void;
  onSend: (
    prompt: string,
    attachments: ChatAttachment[],
    commentAttachments: ChatCommentAttachment[],
    vaultContextAttachments?: ChatVaultContextAttachment[],
  ) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  // Opens the global settings dialog (CLI / model / agent picker). The
  // composer's leading gear icon routes here so users can switch models
  // without leaving the chat.
  onOpenSettings?: () => void;
  projectMetadata?: ProjectMetadata;
  onProjectMetadataChange?: (metadata: ProjectMetadata) => void;
}

// Imperative handle so ancestors (e.g. example chips in ChatPane) can
// push text into the composer without owning its draft state.
export interface ChatComposerHandle {
  setDraft: (text: string) => void;
  focus: () => void;
}

/**
 * The chat composer: textarea + paste/drop/attach buttons + @-mention
 * picker. Attachments are uploaded into the active project's folder so
 * the agent can reference them by relative path on its next turn.
 *
 * `@` typed at a word boundary opens a popover listing project files.
 * Selecting one inserts `@<path>` into the prompt and stages it as an
 * attachment so the daemon also includes it explicitly.
 */
export const ChatComposer = forwardRef<ChatComposerHandle, Props>(
  function ChatComposer(
    {
      projectId,
      projectFiles,
      streaming,
      initialDraft,
      onEnsureProject,
      commentAttachments = [],
      onRemoveCommentAttachment,
      onSend,
      onStop,
      onOpenSettings,
      projectMetadata,
      onProjectMetadataChange,
    },
    ref
  ) {
    const t = useT();
    const [draft, setDraft] = useState(initialDraft ?? "");
    const [staged, setStaged] = useState<ChatAttachment[]>([]);
    const [dragActive, setDragActive] = useState(false);
    const [mention, setMention] = useState<{
      q: string;
      cursor: number;
    } | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [importOpen, setImportOpen] = useState(false);
    const [vaultPickerOpen, setVaultPickerOpen] = useState(false);
    const [vaultDesigns, setVaultDesigns] = useState<VaultDesignMeta[]>([]);
    const [vaultLoading, setVaultLoading] = useState(false);
    const [vaultError, setVaultError] = useState<string | null>(null);
    const [vaultQuery, setVaultQuery] = useState("");
    const [vaultContexts, setVaultContexts] = useState<ChatVaultContextAttachment[]>([]);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const importMenuRef = useRef<HTMLDivElement | null>(null);
    const importTriggerRef = useRef<HTMLButtonElement | null>(null);
    const linkedDirs = projectMetadata?.linkedDirs ?? [];
    // initialDraft is only honored on the first non-empty value the parent
    // hands us. After we seed once, the composer is fully under user control
    // — re-renders that pass the same prompt back must not reseed. If the
    // initial useState above already consumed a non-empty initialDraft we
    // mark it seeded immediately, so an early clear by the user (typing or
    // backspace before the parent stops passing initialDraft) does not get
    // overwritten by the effect.
    const seededRef = useRef(Boolean(initialDraft));

    useEffect(() => {
      if (seededRef.current) return;
      if (initialDraft && initialDraft !== draft) {
        setDraft(initialDraft);
        seededRef.current = true;
      } else if (initialDraft === undefined) {
        seededRef.current = true;
      }
    }, [initialDraft, draft]);

    useEffect(() => {
      if (!importOpen) return;
      function onPointer(e: MouseEvent) {
        const target = e.target as Node;
        if (importMenuRef.current?.contains(target)) return;
        if (importTriggerRef.current?.contains(target)) return;
        setImportOpen(false);
      }
      function onKey(e: KeyboardEvent) {
        if (e.key === "Escape") setImportOpen(false);
      }
      document.addEventListener("mousedown", onPointer);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onPointer);
        document.removeEventListener("keydown", onKey);
      };
    }, [importOpen]);

    useEffect(() => {
      if (!vaultPickerOpen || vaultDesigns.length > 0) return;
      let cancelled = false;
      setVaultLoading(true);
      setVaultError(null);
      fetchVaultDesigns()
        .then((designs) => {
          if (cancelled) return;
          setVaultDesigns(designs);
        })
        .catch((error) => {
          if (cancelled) return;
          setVaultError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!cancelled) setVaultLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [vaultPickerOpen, vaultDesigns.length]);

    useEffect(() => {
      if (!vaultPickerOpen) return;
      function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') setVaultPickerOpen(false);
      }
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [vaultPickerOpen]);

    const filteredVaultDesigns = useMemo(() => {
      const q = vaultQuery.trim().toLowerCase();
      return vaultDesigns
        .filter((design) => {
          const hasContext =
            design.kind ||
            design.skillPath ||
            design.designPath ||
            design.openSlideThemePath ||
            design.capabilitiesPath;
          if (!hasContext) return false;
          if (!q) return true;
          return [
            design.title,
            design.slug,
            design.sourceHost,
            design.packageType,
            design.summary,
            ...(design.tags ?? []),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(q);
        })
        .slice(0, 40);
    }, [vaultDesigns, vaultQuery]);

    useImperativeHandle(
      ref,
      () => ({
        setDraft: (text: string) => {
          setDraft(text);
          seededRef.current = true;
          requestAnimationFrame(() => {
            const ta = textareaRef.current;
            if (!ta) return;
            ta.focus();
            const pos = text.length;
            ta.setSelectionRange(pos, pos);
          });
        },
        focus: () => {
          textareaRef.current?.focus();
        },
      }),
      []
    );

    function reset() {
      setDraft("");
      setStaged([]);
      setVaultContexts([]);
      setUploadError(null);
      setMention(null);
    }

    async function ensureProject(): Promise<string | null> {
      if (projectId) return projectId;
      return onEnsureProject();
    }

    async function uploadFiles(files: File[]) {
      if (files.length === 0) return;
      const id = await ensureProject();
      if (!id) return;
      setUploading(true);
      setUploadError(null);
      try {
        const result = await uploadProjectFiles(id, files);
        if (result.uploaded.length > 0) {
          setStaged((s) => [...s, ...result.uploaded]);
        }
        if (result.failed.length > 0) {
          const failedCount = result.failed.length;
          const uploadedCount = result.uploaded.length;
          const detail = result.error ? ` (${result.error})` : '';
          setUploadError(
            uploadedCount > 0
              ? `Attached ${uploadedCount} file(s), but ${failedCount} failed${detail}.`
              : `Attachment upload failed for ${failedCount} file(s)${detail}.`,
          );
          console.warn('Some attachments failed to upload', result.failed);
        }
      } finally {
        setUploading(false);
      }
    }

    function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void uploadFiles(files);
      }
    }

    function handleDrop(e: React.DragEvent<HTMLDivElement>) {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) void uploadFiles(files);
    }

    async function handleLinkFolder() {
      setImportOpen(false);
      if (!projectId) return;
      const selected = await openFolderDialog();
      if (!selected) return;
      const base = projectMetadata ?? { kind: 'prototype' as const };
      const existing = base.linkedDirs ?? [];
      if (existing.includes(selected)) return;
      const metadata: ProjectMetadata = { ...base, linkedDirs: [...existing, selected] };
      const result = await patchProject(projectId, { metadata });
      if (result?.metadata) onProjectMetadataChange?.(result.metadata);
    }

    async function handleUnlinkFolder(dir: string) {
      if (!projectId) return;
      const base = projectMetadata ?? { kind: 'prototype' as const };
      const existing = base.linkedDirs ?? [];
      const metadata: ProjectMetadata = { ...base, linkedDirs: existing.filter((d) => d !== dir) };
      const result = await patchProject(projectId, { metadata });
      if (result?.metadata) onProjectMetadataChange?.(result.metadata);
    }

    function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      const value = e.target.value;
      const cursor = e.target.selectionStart;
      setDraft(value);
      // Detect a fresh @ at start or after whitespace; capture the typed
      // query up to the cursor.
      const before = value.slice(0, cursor);
      const m = /(^|\s)@([^\s@]*)$/.exec(before);
      if (m) setMention({ q: m[2] ?? "", cursor });
      else setMention(null);
    }

    function insertMention(filePath: string) {
      if (!mention) return;
      const ta = textareaRef.current;
      if (!ta) return;
      const cursor = mention.cursor;
      const before = draft.slice(0, cursor);
      const after = draft.slice(cursor);
      const replaced = before.replace(/@([^\s@]*)$/, `@${filePath} `);
      const next = replaced + after;
      setDraft(next);
      setMention(null);
      if (!staged.some((s) => s.path === filePath)) {
        setStaged((s) => [
          ...s,
          {
            path: filePath,
            name: filePath.split("/").pop() || filePath,
            kind: looksLikeImage(filePath) ? "image" : "file",
          },
        ]);
      }
      requestAnimationFrame(() => {
        ta.focus();
        const pos = replaced.length;
        ta.setSelectionRange(pos, pos);
      });
    }

    function removeStaged(p: string) {
      setStaged((s) => s.filter((a) => a.path !== p));
    }

    async function submit() {
      const prompt = draft.trim();
      if ((!prompt && commentAttachments.length === 0 && vaultContexts.length === 0) || streaming) return;
      const sent = await onSend(prompt, staged, commentAttachments, vaultContexts);
      if (sent !== false) reset();
    }

    function handleOpenVaultPicker() {
      setImportOpen(false);
      setVaultPickerOpen(true);
    }

    function addVaultContext(design: VaultDesignMeta) {
      const next = vaultContextFromDesign(design);
      setVaultContexts((curr) => {
        if (curr.some((item) => item.slug === next.slug)) return curr;
        return [...curr, next].slice(-3);
      });
      setVaultPickerOpen(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }

    function removeVaultContext(slug: string) {
      setVaultContexts((curr) => curr.filter((item) => item.slug !== slug));
    }

    // The @-picker treats the project listing as path-shaped (path + size).
    // ProjectFile.path is optional, so fall back to .name for the legacy
    // flat shape — both ChatComposer and the old code paths see the same
    // entries.
    const filteredFiles = mention
      ? projectFiles
          .filter((f) => f.type === undefined || f.type === "file")
          .filter((f) => {
            const key = f.path ?? f.name;
            return key.toLowerCase().includes(mention.q.toLowerCase());
          })
          .slice(0, 12)
      : [];

    return (
      <div
        className={`composer${dragActive ? " drag-active" : ""}`}
        data-testid="chat-composer"
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <div className="composer-shell">
          {staged.length > 0 ? (
            <StagedAttachments
              attachments={staged}
              projectId={projectId}
              onRemove={removeStaged}
              t={t}
            />
          ) : null}
          {linkedDirs.length > 0 ? (
            <div className="linked-dirs-row" data-testid="linked-dirs">
              {linkedDirs.map((dir) => (
                <div key={dir} className="linked-dir-chip">
                  <Icon name="folder" size={13} />
                  <span className="linked-dir-name" title={dir}>
                    {dir.split('/').pop() || dir}
                  </span>
                  <button
                    className="staged-remove"
                    onClick={() => handleUnlinkFolder(dir)}
                    title={t('chat.linkedFolderRemoveAria', { path: dir })}
                    aria-label={t('chat.linkedFolderRemoveAria', { path: dir })}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {commentAttachments.length > 0 ? (
            <StagedCommentAttachments
              attachments={commentAttachments}
              onRemove={(id) => onRemoveCommentAttachment?.(id)}
              t={t}
            />
          ) : null}
          {vaultContexts.length > 0 ? (
            <StagedVaultContextAttachments
              attachments={vaultContexts}
              onRemove={removeVaultContext}
              t={t}
            />
          ) : null}
          <div className="composer-input-wrap">
            <textarea
              ref={textareaRef}
              data-testid="chat-composer-input"
              value={draft}
              placeholder={t('chat.composerPlaceholder')}
              onChange={handleChange}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (mention && e.key === "Escape") {
                  setMention(null);
                  return;
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            {mention && filteredFiles.length > 0 ? (
              <MentionPopover files={filteredFiles} onPick={insertMention} />
            ) : null}
          </div>
          <div className="composer-row">
            <input
              ref={fileInputRef}
              data-testid="chat-file-input"
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                void uploadFiles(files);
                e.target.value = "";
              }}
            />
            <button
              className="icon-btn"
              onClick={() => onOpenSettings?.()}
              title={t('chat.cliSettingsTitle')}
              aria-label={t('chat.cliSettingsAria')}
              disabled={!onOpenSettings}
            >
              <Icon name="sliders" size={15} />
            </button>
            <button
              className="icon-btn"
              data-testid="chat-attach"
              onClick={() => fileInputRef.current?.click()}
              title={t('chat.attachTitle')}
              disabled={uploading}
              aria-label={t('chat.attachAria')}
            >
              {uploading ? (
                <Icon name="spinner" size={15} />
              ) : (
                <Icon name="attach" size={15} />
              )}
            </button>
            <span className="composer-icon-divider" aria-hidden />
            <div className="composer-import-wrap">
              <button
                ref={importTriggerRef}
                type="button"
                className="composer-import"
                onClick={() => setImportOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={importOpen}
                title={t('chat.importTitle')}
              >
                <Icon name="import" size={13} />
                <span>{t('chat.importLabel')}</span>
                <Icon name="chevron-down" size={12} />
              </button>
              {importOpen ? (
                <div
                  ref={importMenuRef}
                  className="composer-import-menu"
                  role="menu"
                >
                  <ImportItem icon="upload" label={t('chat.importFig')} t={t} />
                  <ImportItem icon="link" label={t('chat.importGitHub')} t={t} />
                  <ImportItem icon="grid" label={t('chat.importWeb')} t={t} />
                  <ImportItem
                    icon="folder"
                    label={t('chat.importFolder')}
                    t={t}
                    enabled
                    onClick={handleLinkFolder}
                  />
                  <ImportItem
                    icon="sparkles"
                    label={t('chat.importSkills')}
                    t={t}
                    enabled
                    onClick={handleOpenVaultPicker}
                  />
                  <ImportItem icon="file" label={t('chat.importProject')} t={t} />
                </div>
              ) : null}
            </div>
            <span className="composer-spacer" />
            {streaming ? (
              <button
                type="button"
                className="composer-send stop"
                onClick={onStop}
              >
                <Icon name="stop" size={13} />
                <span>{t('chat.stop')}</span>
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                data-testid="chat-send"
                onClick={() => void submit()}
                disabled={!draft.trim() && commentAttachments.length === 0 && vaultContexts.length === 0}
              >
                <Icon name="send" size={13} />
                <span>{t('chat.send')}</span>
              </button>
            )}
          </div>
        </div>
        {uploadError ? <span className="composer-hint">{uploadError}</span> : null}
        <span className="composer-hint">{t('chat.composerHint')}</span>
        {vaultPickerOpen ? (
          <VaultContextPicker
            designs={filteredVaultDesigns}
            selected={vaultContexts}
            query={vaultQuery}
            loading={vaultLoading}
            error={vaultError}
            onQueryChange={setVaultQuery}
            onPick={addVaultContext}
            onClose={() => setVaultPickerOpen(false)}
            t={t}
          />
        ) : null}
      </div>
    );
  }
);

function StagedAttachments({
  attachments,
  projectId,
  onRemove,
  t,
}: {
  attachments: ChatAttachment[];
  projectId: string | null;
  onRemove: (path: string) => void;
  t: TranslateFn;
}) {
  return (
    <div className="staged-row" data-testid="staged-attachments">
      {attachments.map((a) => (
        <div key={a.path} className={`staged-chip staged-${a.kind}`}>
          {a.kind === "image" && projectId ? (
            <img src={projectRawUrl(projectId, a.path)} alt={a.name} />
          ) : (
            <span className="staged-icon" aria-hidden>
              <Icon name="file" size={13} />
            </span>
          )}
          <span className="staged-name" title={a.path}>
            {a.name}
          </span>
          <button
            className="staged-remove"
            onClick={() => onRemove(a.path)}
            title={t('common.delete')}
            aria-label={t('chat.removeAria', { name: a.name })}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

function StagedCommentAttachments({
  attachments,
  onRemove,
  t,
}: {
  attachments: ChatCommentAttachment[];
  onRemove: (id: string) => void;
  t: TranslateFn;
}) {
  return (
    <div className="staged-row comment-staged-row" data-testid="staged-comment-attachments">
      {attachments.map((a) => (
        <div key={a.id} className="staged-chip staged-comment">
          <span className="staged-name" title={`${a.elementId}: ${a.comment}`}>
            <strong>{a.elementId}</strong>
            <span>{a.comment}</span>
          </span>
          <button
            className="staged-remove"
            onClick={() => onRemove(a.id)}
            title={t('chat.comments.removeAttachment')}
            aria-label={t('chat.comments.removeAttachmentAria', { name: a.elementId })}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

function StagedVaultContextAttachments({
  attachments,
  onRemove,
  t,
}: {
  attachments: ChatVaultContextAttachment[];
  onRemove: (slug: string) => void;
  t: TranslateFn;
}) {
  return (
    <div className="staged-row vault-context-staged-row" data-testid="staged-vault-context-attachments">
      {attachments.map((a) => (
        <div key={a.slug} className="staged-chip staged-vault-context">
          <span className="staged-icon" aria-hidden>
            <Icon name={a.kind === 'skill-package' ? 'sparkles' : 'file'} size={13} />
          </span>
          <span className="staged-name" title={`${a.title} · ${a.slug}`}>
            <strong>{a.title}</strong>
            <span>{vaultKindLabel(a, t)}</span>
          </span>
          <button
            className="staged-remove"
            onClick={() => onRemove(a.slug)}
            title={t('chat.vaultContextRemove')}
            aria-label={t('chat.vaultContextRemoveAria', { name: a.title })}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

type VaultKindKey = 'design-system' | 'skill-package';
type VaultSourceKey = 'url' | 'clone-website' | 'design-system-project';
type VaultSortKey = 'quality' | 'recent' | 'title';

function vaultKindKey(design: VaultDesignMeta): VaultKindKey {
  return vaultContextFromDesign(design).kind === 'skill-package' ? 'skill-package' : 'design-system';
}

function vaultRawScore(design: VaultDesignMeta): number | null {
  const quality = (design.profile as { quality?: { score?: unknown } } | undefined)?.quality;
  return typeof quality?.score === 'number' && Number.isFinite(quality.score) ? quality.score : null;
}

function vaultTimestamp(design: VaultDesignMeta): number {
  const ts = Date.parse(design.updatedAt ?? design.createdAt ?? '');
  return Number.isFinite(ts) ? ts : 0;
}

function VaultContextPicker({
  designs,
  selected,
  query,
  loading,
  error,
  onQueryChange,
  onPick,
  onClose,
  t,
}: {
  designs: VaultDesignMeta[];
  selected: ChatVaultContextAttachment[];
  query: string;
  loading: boolean;
  error: string | null;
  onQueryChange: (value: string) => void;
  onPick: (design: VaultDesignMeta) => void;
  onClose: () => void;
  t: TranslateFn;
}) {
  const selectedSlugs = useMemo(() => new Set(selected.map((item) => item.slug)), [selected]);

  const [kindFilter, setKindFilter] = useState<'all' | VaultKindKey>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | VaultSourceKey>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [qualityOnly, setQualityOnly] = useState(false);
  const [sortKey, setSortKey] = useState<VaultSortKey>('quality');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  // Tag option pool derived from the un-chip-filtered list so the user can
  // always see which tags are reachable from their current text query.
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const design of designs) {
      for (const tag of design.tags ?? []) {
        const trimmed = String(tag || '').trim();
        if (!trimmed) continue;
        counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8);
  }, [designs]);

  // Same logic for source counts so chips report what's actually selectable.
  const sourceCounts = useMemo(() => {
    const map = new Map<VaultSourceKey, number>();
    for (const design of designs) {
      const key = (design.sourceMode || 'url') as VaultSourceKey;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [designs]);

  const kindCounts = useMemo(() => {
    const map = new Map<VaultKindKey, number>();
    for (const design of designs) {
      const key = vaultKindKey(design);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [designs]);

  const visibleDesigns = useMemo(() => {
    const filtered = designs.filter((design) => {
      if (kindFilter !== 'all' && vaultKindKey(design) !== kindFilter) return false;
      if (sourceFilter !== 'all' && (design.sourceMode || 'url') !== sourceFilter) return false;
      if (tagFilter !== 'all' && !(design.tags ?? []).includes(tagFilter)) return false;
      if (qualityOnly) {
        const score = vaultRawScore(design);
        if (score === null || score < 90) return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      if (sortKey === 'title') return (a.title || a.slug).localeCompare(b.title || b.slug);
      if (sortKey === 'recent') return vaultTimestamp(b) - vaultTimestamp(a);
      // quality
      const sb = vaultRawScore(b) ?? -1;
      const sa = vaultRawScore(a) ?? -1;
      if (sb !== sa) return sb - sa;
      return vaultTimestamp(b) - vaultTimestamp(a);
    });
    return filtered;
  }, [designs, kindFilter, sourceFilter, tagFilter, qualityOnly, sortKey]);

  // Clamp active index whenever the list shrinks/grows.
  useEffect(() => {
    if (visibleDesigns.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
      return;
    }
    if (activeIndex >= visibleDesigns.length) setActiveIndex(visibleDesigns.length - 1);
  }, [visibleDesigns.length, activeIndex]);

  // Scroll active row into view on keyboard navigation.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const activeDesign = visibleDesigns[activeIndex] ?? null;

  function handleKey(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (visibleDesigns.length === 0) return;
      setActiveIndex((i) => Math.min(i + 1, visibleDesigns.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (visibleDesigns.length === 0) return;
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      const design = visibleDesigns[activeIndex];
      if (!design) return;
      if (selectedSlugs.has(design.slug)) return;
      event.preventDefault();
      onPick(design);
    }
  }

  const filterActive =
    kindFilter !== 'all' || sourceFilter !== 'all' || tagFilter !== 'all' || qualityOnly;

  function clearFilters() {
    setKindFilter('all');
    setSourceFilter('all');
    setTagFilter('all');
    setQualityOnly(false);
  }

  return (
    <div
      className="vault-context-picker-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="vault-context-picker vault-context-picker-v2"
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.vaultContextPickerTitle')}
        onKeyDown={handleKey}
      >
        <header className="vault-context-picker-head">
          <div>
            <h3>{t('chat.vaultContextPickerTitle')}</h3>
            <p>{t('chat.vaultContextPickerDesc')}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="vault-context-controls">
          <div className="vault-context-search-row">
            <label className="vault-context-search">
              <Icon name="search" size={14} />
              <input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={t('chat.vaultContextSearch')}
                autoFocus
              />
            </label>
            <select
              className="vault-context-select"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
              title={t('chat.vaultContextFilterKind')}
            >
              <option value="all">
                {t('chat.vaultContextFilterKind')} · {t('chat.vaultContextFilterAll')}
              </option>
              <option value="design-system">
                {t('chat.vaultContextDesignSystem')} ({kindCounts.get('design-system') ?? 0})
              </option>
              <option value="skill-package">
                {t('chat.vaultContextSkill')} ({kindCounts.get('skill-package') ?? 0})
              </option>
            </select>
            <select
              className="vault-context-select"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
              title={t('chat.vaultContextFilterSource')}
            >
              <option value="all">
                {t('chat.vaultContextFilterSource')} · {t('chat.vaultContextFilterAll')}
              </option>
              <option value="url">
                {t('chat.vaultContextSourceUrl')} ({sourceCounts.get('url') ?? 0})
              </option>
              <option value="clone-website">
                {t('chat.vaultContextSourceClone')} ({sourceCounts.get('clone-website') ?? 0})
              </option>
              <option value="design-system-project">
                {t('chat.vaultContextSourceProject')} ({sourceCounts.get('design-system-project') ?? 0})
              </option>
            </select>
            <select
              className="vault-context-select"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              title={t('chat.vaultContextFilterTag')}
            >
              <option value="all">
                {t('chat.vaultContextFilterTag')} · {t('chat.vaultContextFilterAll')}
              </option>
              {tagOptions.map(([tag, count]) => (
                <option key={tag} value={tag}>
                  {tag} ({count})
                </option>
              ))}
            </select>
            <select
              className="vault-context-select"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as VaultSortKey)}
              title={t('chat.vaultContextSortQuality')}
            >
              <option value="quality">↕ {t('chat.vaultContextSortQuality')}</option>
              <option value="recent">↕ {t('chat.vaultContextSortRecent')}</option>
              <option value="title">↕ {t('chat.vaultContextSortTitle')}</option>
            </select>
            <button
              type="button"
              className={`vault-context-toggle${qualityOnly ? ' active' : ''}`}
              onClick={() => setQualityOnly((v) => !v)}
              title={t('chat.vaultContextFilterQualityHint')}
              aria-pressed={qualityOnly}
            >
              ✦ {t('chat.vaultContextFilterQuality')}
            </button>
            {filterActive ? (
              <button
                type="button"
                className="vault-context-clear-filters"
                onClick={clearFilters}
              >
                <Icon name="close" size={11} />
                <span>{t('chat.vaultContextClearFilters')}</span>
              </button>
            ) : null}
            <span className="vault-context-count">
              {t('chat.vaultContextResultCount', {
                filtered: String(visibleDesigns.length),
                total: String(designs.length),
              })}
            </span>
          </div>
        </div>

        <div className="vault-context-body">
          <div className="vault-context-list" ref={listRef}>
            {loading ? <div className="vault-context-empty">{t('chat.vaultContextLoading')}</div> : null}
            {error ? <div className="vault-context-empty error">{error}</div> : null}
            {!loading && !error && designs.length === 0 ? (
              <div className="vault-context-empty">{t('chat.vaultContextEmpty')}</div>
            ) : null}
            {!loading && !error && designs.length > 0 && visibleDesigns.length === 0 ? (
              <div className="vault-context-empty">{t('chat.vaultContextNoMatch')}</div>
            ) : null}
            {visibleDesigns.map((design, index) => {
              const attachment = vaultContextFromDesign(design);
              const isSelected = selectedSlugs.has(attachment.slug);
              const isActive = index === activeIndex;
              return (
                <VaultContextCompactRow
                  key={design.slug}
                  ref={isActive ? activeRowRef : undefined}
                  design={design}
                  attachment={attachment}
                  selected={isSelected}
                  active={isActive}
                  onActivate={() => setActiveIndex(index)}
                  onPick={() => {
                    if (!isSelected) onPick(design);
                  }}
                  t={t}
                />
              );
            })}
          </div>

          <aside className="vault-context-preview-pane">
            {activeDesign ? (
              <VaultContextPreviewCard
                design={activeDesign}
                attachment={vaultContextFromDesign(activeDesign)}
                selected={selectedSlugs.has(activeDesign.slug)}
                onPick={() => {
                  const attachment = vaultContextFromDesign(activeDesign);
                  if (!selectedSlugs.has(attachment.slug)) onPick(activeDesign);
                }}
                t={t}
              />
            ) : (
              <div className="vault-context-preview-empty">
                {t('chat.vaultContextEmptySelection')}
              </div>
            )}
            <div className="vault-context-preview-hint">
              {t('chat.vaultContextPreviewHint')}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

const VaultContextCompactRow = forwardRef<
  HTMLButtonElement,
  {
    design: VaultDesignMeta;
    attachment: ChatVaultContextAttachment;
    selected: boolean;
    active: boolean;
    onActivate: () => void;
    onPick: () => void;
    t: TranslateFn;
  }
>(function VaultContextCompactRow(
  { design, selected, active, onActivate, onPick, t },
  ref,
) {
  const quality = vaultQuality(design);
  const source = vaultSourceLabel(design);
  return (
    <button
      ref={ref}
      type="button"
      className={
        'vault-context-row' +
        (active ? ' active' : '') +
        (selected ? ' selected' : '')
      }
      onMouseEnter={onActivate}
      onFocus={onActivate}
      onClick={onPick}
      disabled={selected}
      title={`${design.title} · ${design.slug}`}
    >
      <span className={`vault-context-row-score ${quality.tone}`} aria-hidden>
        {quality.label.replace('/100', '')}
      </span>
      <span className="vault-context-row-main">
        <span className="vault-context-row-title">{design.title || design.slug}</span>
        <span className="vault-context-row-meta">
          <span className="vault-context-row-source">{source}</span>
          {design.summary ? (
            <>
              <span className="vault-context-row-dot" aria-hidden>·</span>
              <span className="vault-context-row-summary">{design.summary}</span>
            </>
          ) : null}
        </span>
      </span>
      {selected ? (
        <span className="vault-context-row-selected" aria-hidden>
          <Icon name="check" size={12} />
        </span>
      ) : null}
    </button>
  );
});

function VaultContextPreviewCard({
  design,
  attachment,
  selected,
  onPick,
  t,
}: {
  design: VaultDesignMeta;
  attachment: ChatVaultContextAttachment;
  selected: boolean;
  onPick: () => void;
  t: TranslateFn;
}) {
  const previewSrc = vaultPreviewSrc(design);
  const palette = vaultPalette(design);
  const tags = vaultTags(design, attachment, t);
  const quality = vaultQuality(design);
  const source = vaultSourceLabel(design);
  return (
    <button
      type="button"
      className={`vault-context-option vault-context-card${selected ? ' selected' : ''}`}
      onClick={() => {
        if (!selected) onPick();
      }}
      disabled={selected}
      title={`${design.title} · ${design.slug}`}
    >
      <span className="vault-context-card-top">
        <span className="vault-context-source">{source}</span>
        <span className={`vault-context-quality ${quality.tone}`}>{quality.label}</span>
        <span className="vault-context-kind">{vaultKindLabel(attachment, t)}</span>
        <span className="vault-context-mode">{vaultModeLabel(design)}</span>
      </span>
      <span className="vault-context-card-title">{design.title || design.slug}</span>
      <span className="vault-context-thumb" aria-hidden>
        {previewSrc ? (
          previewSrc.kind === 'image' ? (
            <img src={previewSrc.src} alt="" />
          ) : (
            <VaultPreviewFrame
              className="vault-context-frame-wrap"
              src={previewSrc.src}
              title={previewSrc.title}
              width={previewSrc.width}
              height={previewSrc.height}
              sandbox=""
            />
          )
        ) : (
          <span className="vault-context-thumb-fallback">
            <Icon name={attachment.kind === 'skill-package' ? 'sparkles' : 'layout'} size={16} />
          </span>
        )}
      </span>
      <span className="vault-context-palette" aria-hidden>
        {palette.map((item) => (
          <span key={item.label} className="vault-context-palette-item">
            <i style={{ background: item.color }} />
            <em>{item.label}</em>
          </span>
        ))}
      </span>
      <span className="vault-context-option-summary">
        {design.summary || attachment.activationPrompt || t('chat.vaultContextNoSummary')}
      </span>
      {tags.length > 0 ? (
        <span className="vault-context-tags">
          {tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </span>
      ) : null}
      {selected ? <span className="vault-context-selected-badge">{t('chat.vaultContextSelected')}</span> : null}
    </button>
  );
}

function vaultContextFromDesign(design: VaultDesignMeta): ChatVaultContextAttachment {
  const hasLegacySkillSignals =
    design.packageType === 'component-system' ||
    design.packageType === 'presentation-system' ||
    design.packageType === 'agent-skill-package' ||
    Boolean(design.skillPath || design.capabilitiesPath);
  const kind =
    design.kind === 'skill-package'
      ? 'skill-package'
      : design.kind === 'prompt-context'
        ? 'prompt-context'
        : hasLegacySkillSignals
          ? 'skill-package'
          : 'prompt-context';
  const attachment: ChatVaultContextAttachment = {
    slug: design.slug,
    title: design.title || design.slug,
    kind,
  };
  if (design.packageType) attachment.packageType = design.packageType;
  if (design.summary) attachment.summary = design.summary;
  if (design.previewImage || design.previews?.card) attachment.previewImage = design.previewImage || design.previews.card;
  if (design.activationPrompt) attachment.activationPrompt = design.activationPrompt;
  return attachment;
}

function vaultKindLabel(item: Pick<ChatVaultContextAttachment, 'kind' | 'packageType'>, t: TranslateFn) {
  if (item.kind === 'skill-package') {
    if (item.packageType === 'component-system') return t('chat.vaultContextComponentSystem');
    if (item.packageType === 'presentation-system') return t('chat.vaultContextPresentationSystem');
    return t('chat.vaultContextSkill');
  }
  return t('chat.vaultContextDesignSystem');
}

function vaultPreviewSrc(design: VaultDesignMeta) {
  return vaultTemplateCoverPreviewSource(design);
}

function vaultSourceLabel(design: VaultDesignMeta): string {
  if (design.sourceHost) return design.sourceHost;
  try {
    return new URL(design.sourceUrl).host;
  } catch {
    return design.slug;
  }
}

function vaultModeLabel(design: VaultDesignMeta): string {
  if (design.sourceMode === 'design-system-project') return 'PROJECT';
  if (design.sourceMode === 'clone-website') return 'CLONE';
  return 'URL';
}

function vaultQuality(design: VaultDesignMeta): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  const quality = (design.profile as ({ quality?: { score?: unknown; grade?: unknown } } | undefined))?.quality;
  const rawScore = typeof quality?.score === 'number' ? quality.score : null;
  if (rawScore === null || !Number.isFinite(rawScore)) return { label: '--', tone: 'neutral' };
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const grade = typeof quality?.grade === 'string' ? quality.grade : '';
  const tone =
    grade === 'blocked' || score < 72
      ? 'bad'
      : grade === 'needs-review' || score < 86
        ? 'warn'
        : 'good';
  return { label: `${score}/100`, tone };
}

function vaultPalette(design: VaultDesignMeta): Array<{ label: string; color: string }> {
  const roles = design.profile?.colorRoles;
  const tokens = design.tokens && typeof design.tokens === 'object'
    ? design.tokens as { colors?: Record<string, unknown> }
    : null;
  const colors = tokens?.colors;
  const background =
    roles?.background || readColor(colors, ['background', 'bg', 'surface', 'canvas']) || '#111111';
  const text = roles?.text || readColor(colors, ['text', 'foreground', 'primaryText']) || '#f8fafc';
  const cta =
    roles?.brandPrimary || readColor(colors, ['brandPrimary', 'primary', 'accent', 'cta']) || '#e67652';
  const muted =
    roles?.brandSecondary || readColor(colors, ['brandSecondary', 'secondary', 'muted', 'subtle']) || '#2b2a25';
  return [
    { label: 'BG', color: background },
    { label: 'TEXT', color: text },
    { label: 'CTA', color: cta },
    { label: 'MUTED', color: muted },
  ];
}

function readColor(colors: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!colors) return null;
  for (const key of keys) {
    const value = colors[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function vaultTags(design: VaultDesignMeta, attachment: ChatVaultContextAttachment, t: TranslateFn): string[] {
  const tags = [
    vaultKindLabel(attachment, t),
    ...(design.profile?.useCaseTags ?? []),
    ...(design.profile?.toneTags ?? []),
    ...(design.tags ?? []),
    design.packageType ?? '',
  ];
  const cleaned: string[] = [];
  for (const tag of tags) {
    const value = String(tag || '').trim();
    if (!value || cleaned.includes(value)) continue;
    cleaned.push(value);
    if (cleaned.length >= 3) break;
  }
  return cleaned;
}

function ImportItem({
  icon,
  label,
  t,
  enabled,
  onClick,
}: {
  icon: "upload" | "link" | "grid" | "folder" | "sparkles" | "file";
  label: string;
  t: TranslateFn;
  enabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`composer-import-item${enabled ? ' composer-import-item-enabled' : ''}`}
      role="menuitem"
      tabIndex={-1}
      disabled={!enabled}
      title={enabled ? label : t('chat.importComingSoon')}
      onClick={enabled && onClick ? onClick : (e) => e.preventDefault()}
    >
      <span className="ico" aria-hidden>
        <Icon name={icon} size={14} />
      </span>
      <span className="composer-import-item-label">{label}</span>
      {!enabled && <span className="composer-import-item-soon">{t('chat.importSoon')}</span>}
    </button>
  );
}


function MentionPopover({
  files,
  onPick,
}: {
  files: ProjectFile[];
  onPick: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [files]);
  return (
    <div className="mention-popover" data-testid="mention-popover" ref={ref}>
      {files.map((f) => {
        const key = f.path ?? f.name;
        return (
          <button
            key={key}
            className="mention-item"
            onClick={() => onPick(key)}
          >
            <code>{key}</code>
            {f.size != null ? (
              <span className="mention-meta">{prettySize(f.size)}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function looksLikeImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name);
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
