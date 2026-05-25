import type { Dict } from '../i18n/types';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

export function isOpenPptDeckSourceName(name: string): boolean {
  return /^slides\/[^/]+\/index\.tsx$/.test(name);
}

export function openPptDeckSourceLabel(name: string, t: TranslateFn) {
  const slideId = name.match(/^slides\/([^/]+)\/index\.tsx$/)?.[1] ?? null;
  const suffix = slideId && slideId !== 'main-deck' ? ` · ${slideId}` : '';
  return {
    title: `${t('app.brand')} ${t('openPpt.webPptDeck')}${suffix}`,
    subtitle: `${t('openPpt.coreArtifact')} · ${name}`,
  };
}
