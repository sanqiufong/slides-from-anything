import { useEffect, useId, useRef, useState } from 'react';
import type { DeckVersionsResponse } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? value.message ?? String(value.error ?? response.status));
  return value as T;
}

export function DeckHistory({ projectId, slideId, revision, disabled, onRestored }: {
  projectId: string; slideId: string; revision: number; disabled: boolean; onRestored: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<DeckVersionsResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/open-slide/versions`;
  const query = `?slideId=${encodeURIComponent(slideId)}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setHistory(null);
    setError('');
    void request<DeckVersionsResponse>(endpoint + query, { signal: controller.signal }).then(setHistory).catch(error => {
      if (!controller.signal.aborted) setError(String(error.message));
    });
    return () => controller.abort();
  }, [open, endpoint, query, revision]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  async function act(versionId?: string) {
    if (busy || disabled || !history) return;
    setBusy(true);
    setError('');
    try {
      await request(endpoint + (versionId ? '/restore' : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slideId, versionId, expectedDigest: history.currentDigest }),
      });
      if (versionId) await onRestored();
      setHistory(await request<DeckVersionsResponse>(endpoint + query));
    } catch (error) { setError(String((error as Error).message)); }
    finally { setBusy(false); }
  }
  return <div className="deck-history" ref={container}>
    <button ref={trigger} type="button" className={`open-slide-topbar-button ${open ? 'active' : ''}`}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="history" size={14} /><span>{t('versions.title')}</span>
    </button>
    {open ? <section className="deck-history-popover" role="dialog" aria-labelledby={titleId}>
      <div className="deck-history-head"><strong id={titleId}>{t('versions.title')}</strong>
        <button type="button" aria-label={t('common.close')} onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button></div>
      <p>{t('versions.help')}</p>
      {disabled ? <p className="deck-history-pending">{t('versions.pending')}</p> : null}
      <button type="button" className="deck-history-save" disabled={disabled || busy || !history} onClick={() => void act()}>
        {busy ? t('common.loading') : t('versions.save')}
      </button>
      {error ? <p role="alert" className="deck-history-error">{error}</p> : null}
      {!history && !error ? <p role="status">{t('common.loading')}</p> : null}
      {history?.versions.length === 0 ? <p>{t('versions.empty')}</p> : null}
      <ol className="deck-history-list">{history?.versions.map(version => <li key={version.id}>
        <div><time dateTime={new Date(version.createdAt).toISOString()}>{new Date(version.createdAt).toLocaleString(locale)}</time>
          <small>{t(version.reason === 'manual' ? 'versions.manual' : version.reason === 'restore' ? 'versions.restored' : 'versions.automatic')}
            {' · '}{t('versions.files', { count: version.fileCount })}</small></div>
        <button type="button" disabled={disabled || busy || version.digest === history.currentDigest} onClick={() => void act(version.id)}>
          {version.digest === history.currentDigest ? t('versions.current') : t('versions.restore')}
        </button>
      </li>)}</ol>
    </section> : null}
  </div>;
}
