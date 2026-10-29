import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeckVersionStore } from '../src/deck-versions.js';
import { checkDeckDelivery, validateDeckSource } from '../src/deck-delivery.js';
import { evaluateOpenPptDeck } from '../src/openppt-export.js';

const roots: string[] = [];
const deck = (title: string, body = '') => `export default [() => <main><h1>${title}</h1>${body}</main>];`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-deck-lifecycle-'));
  roots.push(root);
  const projects = path.join(root, 'projects');
  const directory = path.join(projects, 'project', 'slides', 'deck');
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await writeFile(path.join(directory, 'index.tsx'), deck('First', '<img src="assets/a.png" />'));
  await writeFile(path.join(directory, 'assets/a.png'), Buffer.from([0, 255, 12, 128]));
  return { root, projects, directory, store: new DeckVersionStore(projects, path.join(root, 'versions')) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('persistent deck versions', () => {
  it('restores source and binary assets after reopening, preserves current work and hidden state', async () => {
    const { root, projects, directory, store } = await fixture();
    const first = await store.capture('project', 'deck', { reason: 'manual' });
    await writeFile(path.join(directory, 'index.tsx'), deck('Second'));
    await writeFile(path.join(directory, 'assets/a.png'), 'changed');
    await writeFile(path.join(directory, '.editor-state'), 'keep');
    const reopened = new DeckVersionStore(projects, path.join(root, 'versions'));
    const current = await reopened.list('project', 'deck');
    const restored = await reopened.restore('project', 'deck', first.id, current.currentDigest, validateDeckSource);
    expect(await readFile(path.join(directory, 'index.tsx'), 'utf8')).toContain('First');
    expect(await readFile(path.join(directory, 'assets/a.png'))).toEqual(Buffer.from([0, 255, 12, 128]));
    expect(await readFile(path.join(directory, '.editor-state'), 'utf8')).toBe('keep');
    expect(restored.restoredFrom).toBe(first.id);
    const versions = await reopened.list('project', 'deck');
    expect(versions.versions).toHaveLength(3);
    const second = versions.versions.find(version => version.reason === 'before-edit')!;
    await reopened.restore('project', 'deck', second.id, versions.currentDigest, validateDeckSource);
    expect(await readFile(path.join(directory, 'index.tsx'), 'utf8')).toContain('Second');
  });

  it('rejects stale restores and corrupted assets before replacing live source', async () => {
    const { root, directory, store } = await fixture();
    const saved = await store.capture('project', 'deck', { reason: 'manual' });
    await writeFile(path.join(directory, 'index.tsx'), deck('Keep current'));
    await expect(store.restore('project', 'deck', saved.id, saved.digest, validateDeckSource)).rejects.toThrow('CONFLICT');
    const manifest = JSON.parse(await readFile(path.join(root, 'versions/project/deck/manifest.json'), 'utf8'));
    const blob = manifest.versions[0].files.find((file: { path: string }) => file.path === 'assets/a.png').digest;
    await writeFile(path.join(root, 'versions/project/deck/blobs', blob), 'corrupted');
    const current = await store.list('project', 'deck');
    await expect(store.restore('project', 'deck', saved.id, current.currentDigest, validateDeckSource)).rejects.toThrow('integrity');
    expect(await readFile(path.join(directory, 'index.tsx'), 'utf8')).toContain('Keep current');
  });

  it('rejects invalid source, traversal and symlinks without changing current files', async () => {
    const { directory, store } = await fixture();
    await writeFile(path.join(directory, 'index.tsx'), 'export default [];');
    const broken = await store.capture('project', 'deck', { reason: 'manual' });
    await writeFile(path.join(directory, 'index.tsx'), deck('Valid'));
    const current = await store.list('project', 'deck');
    await expect(store.restore('project', 'deck', broken.id, current.currentDigest, validateDeckSource)).rejects.toThrow('Page[]');
    await expect(store.list('../project', 'deck')).rejects.toThrow('Invalid');
    await symlink('/tmp', path.join(directory, 'assets/link'));
    await expect(store.capture('project', 'deck', { reason: 'manual' })).rejects.toThrow('symlink');
    expect(await readFile(path.join(directory, 'index.tsx'), 'utf8')).toContain('Valid');
  });
});

describe('deck delivery checks', () => {
  it('bounds execution time for a deck stuck in a render loop', async () => {
    const { directory } = await fixture();
    await expect(evaluateOpenPptDeck({ source: 'export default [() => { while (true) {} }];', slideDir: directory, renderTimeoutMs: 50 }))
      .rejects.toThrow(/timed out/);
  });
  it('allows planning-only runs and checks valid changed decks without certifying visual quality', async () => {
    const { directory } = await fixture();
    const input = { slideId: 'deck', slideDir: directory, animations: false };
    expect((await checkDeckDelivery({ ...input, changed: false })).status).toBe('not_required');
    const report = await checkDeckDelivery({ ...input, changed: true });
    expect(report.status).toBe('passed');
    expect(report.pageCount).toBe(1);
    expect(report.visualReview).toBe('pending');
    expect(report.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('resolves quoted CSS asset URLs escaped by static HTML rendering', async () => {
    const { directory } = await fixture();
    await writeFile(path.join(directory, 'index.tsx'), 'export default [() => <div style={{backgroundImage: `url("assets/a.png")`}} />];');
    const report = await checkDeckDelivery({ slideId: 'deck', slideDir: directory, changed: true, animations: false });
    expect(report.status).toBe('passed');
  });
  it('fails missing assets, invalid runtime exports and required motion', async () => {
    const { directory } = await fixture();
    const input = { slideId: 'deck', slideDir: directory, changed: true, animations: false };
    await rm(path.join(directory, 'assets/a.png'));
    expect((await checkDeckDelivery(input)).checks.find(check => check.name === 'assets')?.status).toBe('failed');
    await writeFile(path.join(directory, 'index.tsx'), 'export default [() => <Missing />];');
    expect((await checkDeckDelivery(input)).checks.find(check => check.name === 'render')?.status).toBe('failed');
    await writeFile(path.join(directory, 'index.tsx'), deck('No motion'));
    expect((await checkDeckDelivery({ ...input, animations: true })).status).toBe('failed');
  });
});
