// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VaultTemplatesTab } from '../../src/components/VaultTemplatesTab';
import type { VaultDesignMeta } from '../../src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hardWorkClub = vi.hoisted<VaultDesignMeta>(() => ({
  slug: 'hard-work-club-www-hardworkclub-com',
  title: 'Hard Work Club',
  sourceUrl: 'https://hardworkclub.com',
  sourceHost: 'hardworkclub.com',
  sourceMode: 'url',
  status: 'ready',
  summary: 'Animated editorial studio card.',
  tags: ['source-derived web style sys', 'presentation-template'],
  previewImage: '/static/hard-work-club.jpg',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  designPath: '',
  openSlideThemePath: '',
  evidencePath: '',
  profilePath: '',
  assets: [],
  previews: { web: 'web.html', ppt: 'ppt.html', card: 'card.html' },
  profile: { archetype: 'source-derived interactive visual system' },
}));

const atelier = vi.hoisted<VaultDesignMeta>(() => ({
  ...hardWorkClub,
  slug: 'atelier-selected-works',
  title: 'Atelier',
  sourceHost: 'atelier.example',
  summary: 'Quiet portfolio template.',
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  favorite: true,
  profile: { archetype: 'presentation design system' },
}));

const zine = vi.hoisted<VaultDesignMeta>(() => ({
  ...hardWorkClub,
  slug: 'zine-cover-system',
  title: 'Zine Cover System',
  sourceHost: 'zine.example',
  summary: 'Expressive editorial cover system.',
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  profile: { archetype: 'magazine-layout' },
}));

const deleteVaultDesignMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, slug: 'hard-work-club-www-hardworkclub-com', deleted: true })));
const confirmMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../src/providers/registry', () => ({
  createVaultIngestion: vi.fn(),
  deleteVaultDesign: deleteVaultDesignMock,
  fetchVaultDesigns: vi.fn(async () => [hardWorkClub, atelier, zine]),
  fetchVaultDiscovery: vi.fn(async () => null),
  fetchVaultJob: vi.fn(),
  fetchVaultStatus: vi.fn(async () => ({
    ingestionAvailable: false,
    designsRoot: '/tmp/design-vault/data/designs',
  })),
  syncVaultDesignSystems: vi.fn(),
}));

describe('VaultTemplatesTab', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    deleteVaultDesignMock.mockClear();
    confirmMock.mockClear();
    vi.stubGlobal('confirm', confirmMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    host.remove();
    document.body.innerHTML = '';
  });

  it('uses card preview iframe with library surface before ppt or preview images', async () => {
    await act(async () => {
      root.render(<VaultTemplatesTab />);
      await Promise.resolve();
    });

    const iframe = [...document.querySelectorAll<HTMLIFrameElement>('.vault-thumb iframe')]
      .find((node) => node.getAttribute('src')?.includes(hardWorkClub.slug));

    expect(iframe?.getAttribute('src')).toBe(
      '/api/vault/designs/hard-work-club-www-hardworkclub-com/preview?kind=card&surface=library',
    );
    expect(iframe?.getAttribute('title')).toBe('Hard Work Club style card preview');
    expect(iframe?.getAttribute('loading')).toBe('lazy');
    expect(document.querySelector('.vault-thumb img')).toBeNull();
    expect(document.body.textContent).toContain('交互视觉系统');
    expect(document.body.textContent).toContain('网站风格');
    expect(document.body.textContent).not.toContain('source-derived interactive visual system');
  });

  it('sorts templates by the selected sort mode', async () => {
    await act(async () => {
      root.render(<VaultTemplatesTab />);
      await Promise.resolve();
    });

    const sortSelect = document.querySelector<HTMLSelectElement>('.vault-sort-select');
    expect(sortSelect).not.toBeNull();

    await act(async () => {
      sortSelect!.value = 'title';
      sortSelect!.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const titles = [...document.querySelectorAll('.ds-card-title')].map((node) => node.textContent);
    expect(titles).toEqual(['Atelier', 'Hard Work Club', 'Zine Cover System']);
  });

  it('defaults to recently updated and can filter favorites from the upstream marker', async () => {
    await act(async () => {
      root.render(<VaultTemplatesTab />);
      await Promise.resolve();
    });

    const sortSelect = document.querySelector<HTMLSelectElement>('.vault-sort-select');
    expect(sortSelect?.value).toBe('updated');
    expect([...document.querySelectorAll('.ds-card-title')].map((node) => node.textContent)).toEqual([
      'Atelier',
      'Zine Cover System',
      'Hard Work Club',
    ]);

    const filterToggle = document.querySelector<HTMLButtonElement>('.vault-filter-toggle');
    expect(filterToggle).not.toBeNull();
    await act(async () => {
      filterToggle!.click();
      await Promise.resolve();
    });

    const favoriteButton = [...document.querySelectorAll<HTMLButtonElement>('.vault-filter-options button')]
      .find((button) => button.textContent?.includes('My favorites'));
    expect(favoriteButton).not.toBeNull();
    await act(async () => {
      favoriteButton!.click();
      await Promise.resolve();
    });

    expect([...document.querySelectorAll('.ds-card-title')].map((node) => node.textContent)).toEqual(['Atelier']);
  });

  it('deletes a template from the library after confirmation', async () => {
    await act(async () => {
      root.render(<VaultTemplatesTab />);
      await Promise.resolve();
    });

    const deleteButton = document.querySelector<HTMLButtonElement>('button[title="删除 Hard Work Club"]');
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      deleteButton!.click();
      await Promise.resolve();
    });

    expect(confirmMock).toHaveBeenCalledWith('删除模板「Hard Work Club」？');
    expect(deleteVaultDesignMock).toHaveBeenCalledWith('hard-work-club-www-hardworkclub-com');
    const titles = [...document.querySelectorAll('.ds-card-title')].map((node) => node.textContent);
    expect(titles).not.toContain('Hard Work Club');
    expect(document.body.textContent).toContain('已删除模板：Hard Work Club');
  });
});
