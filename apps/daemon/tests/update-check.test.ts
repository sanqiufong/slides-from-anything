import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppVersionInfo } from '../src/app-version.js';
import {
  checkForAppUpdates,
  compareSemver,
  updatePlatformKey,
} from '../src/update-check.js';

const CURRENT: AppVersionInfo = {
  version: '1.0.0',
  channel: 'stable',
  packaged: false,
  platform: 'darwin',
  arch: 'arm64',
};

const NOW = new Date('2026-05-25T00:00:00.000Z');

async function writeManifest(value: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sfa-update-manifest-'));
  const file = path.join(dir, 'stable.json');
  await writeFile(file, JSON.stringify(value), 'utf8');
  return file;
}

describe('update checking', () => {
  it('compares semver values with v-prefix and prereleases', () => {
    expect(compareSemver('v1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', 'v1.0.0')).toBe(0);
  });

  it('selects the packaged platform asset key', () => {
    expect(updatePlatformKey(CURRENT)).toBe('mac-arm64');
    expect(updatePlatformKey({ platform: 'win32', arch: 'x64' })).toBe('win-x64');
  });

  it('reports latest when the manifest version matches the current version', async () => {
    const manifestUrl = await writeManifest({ version: '1.0.0', notes: 'Initial public release.' });

    await expect(checkForAppUpdates(CURRENT, {
      env: {},
      manifestUrl,
      now: NOW,
    })).resolves.toMatchObject({
      status: 'latest',
      checkedAt: NOW.toISOString(),
      latestVersion: '1.0.0',
      notes: 'Initial public release.',
      sourceMode: 'source',
    });
  });

  it('reports an available update and matching asset', async () => {
    const manifestUrl = await writeManifest({
      version: '1.0.1',
      releaseUrl: 'https://example.com/releases/v1.0.1',
      assets: {
        'mac-arm64': {
          url: 'https://example.com/releases/v1.0.1/slides-from-anything-mac-arm64.zip',
          sha256: 'abc123',
          size: 42,
        },
      },
    });

    await expect(checkForAppUpdates(CURRENT, {
      env: {},
      manifestUrl,
      now: NOW,
    })).resolves.toMatchObject({
      status: 'available',
      latestVersion: '1.0.1',
      platformKey: 'mac-arm64',
      asset: {
        url: 'https://example.com/releases/v1.0.1/slides-from-anything-mac-arm64.zip',
        sha256: 'abc123',
        size: 42,
      },
      releaseUrl: 'https://example.com/releases/v1.0.1',
    });
  });

  it('can be disabled by environment flag', async () => {
    await expect(checkForAppUpdates(CURRENT, {
      env: { SFA_UPDATE_DISABLED: '1' },
      now: NOW,
    })).resolves.toEqual({
      current: CURRENT,
      status: 'disabled',
      checkedAt: NOW.toISOString(),
      sourceMode: 'source',
    });
  });

  it('returns an error status when a remote manifest cannot be fetched', async () => {
    await expect(checkForAppUpdates(CURRENT, {
      env: {},
      manifestUrl: 'https://example.com/stable.json',
      now: NOW,
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        text: async () => '',
      }),
    })).resolves.toMatchObject({
      status: 'error',
      error: 'update manifest request failed with HTTP 404',
    });
  });
});
