import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeckVersion, DeckVersionsResponse } from '@open-design/contracts/api/openppt';

interface VersionFile { path: string; digest: string; size: number }
interface StoredVersion extends DeckVersion { files: VersionFile[] }
interface Manifest { versions: StoredVersion[] }
type CaptureOptions = Pick<DeckVersion, 'reason' | 'runId' | 'restoredFrom'>;

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROJECT_ID = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 5000;
const locks = new Map<string, Promise<void>>();

export function deckDigest(files: VersionFile[]): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function withDeckLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => tail);
  locks.set(key, queued);
  await previous;
  try { return await work(); } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

async function regular(file: string, directory = false): Promise<void> {
  const entry = await lstat(file);
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) {
    throw new Error('Deck versions require regular files and directories; symlinks are not supported.');
  }
}

async function directories(root: string, parts: string[], create = false): Promise<string> {
  await regular(root, true);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (create) await mkdir(current, { recursive: false }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await regular(current, true);
  }
  return current;
}

function relativeFile(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\\') && value.split('/').every(
    segment => Boolean(segment) && !segment.startsWith('.') && !segment.includes(':') && !segment.includes('\0'),
  );
}

function publicVersion({ files: _files, ...version }: StoredVersion): DeckVersion { return version; }

/** Source and all slide-local assets share a content-addressed snapshot. */
export class DeckVersionStore {
  constructor(private readonly projectsRoot: string, private readonly storageRoot: string) {}

  private async locations(projectId: string, slideId: string) {
    if (!PROJECT_ID.test(projectId) || !ID.test(slideId)) throw new Error('Invalid project or slide id.');
    const slideDir = await directories(this.projectsRoot, [projectId, 'slides', slideId]);
    await mkdir(this.storageRoot, { recursive: true });
    const storeDir = await directories(this.storageRoot, [projectId, slideId], true);
    await directories(storeDir, ['blobs'], true);
    return { slideDir, storeDir, manifestFile: path.join(storeDir, 'manifest.json') };
  }

  private async manifest(file: string): Promise<Manifest> {
    let value: Manifest;
    try {
      await regular(file);
      value = JSON.parse(await readFile(file, 'utf8')) as Manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { versions: [] };
      throw error;
    }
    if (!Array.isArray(value.versions)) throw new Error('Invalid deck version manifest.');
    for (const version of value.versions) {
      if (!ID.test(version.id) || !SHA.test(version.digest) || !Array.isArray(version.files)
        || version.files.length > MAX_FILES) {
        throw new Error('Invalid deck version manifest.');
      }
      const paths = new Set<string>();
      for (const file of version.files) {
        if (!relativeFile(file.path) || !SHA.test(file.digest) || !Number.isSafeInteger(file.size)
          || file.size < 0 || file.size > MAX_BYTES || paths.has(file.path)) {
          throw new Error('Invalid deck version file.');
        }
        paths.add(file.path);
      }
      if (version.files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES
        || deckDigest(version.files) !== version.digest) throw new Error('Deck version manifest integrity check failed.');
    }
    return value;
  }

  private async scan(slideDir: string, storeDir?: string): Promise<VersionFile[]> {
    const files: VersionFile[] = [];
    let total = 0;
    const walk = async (dir: string, prefix: string) => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        // Hidden runtime/editor files are outside the authored deck contract.
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!relativeFile(rel)) throw new Error('Unsupported deck asset path.');
        const absolute = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Cannot snapshot a deck containing symlinks.');
        if (entry.isDirectory()) { await regular(absolute, true); await walk(absolute, rel); continue; }
        await regular(absolute);
        const info = await lstat(absolute);
        total += info.size;
        if (total > MAX_BYTES || files.length >= MAX_FILES) throw new Error('Deck snapshot exceeds the 512 MiB / 5000 file limit.');
        const content = await readFile(absolute);
        const hash = digest(content);
        files.push({ path: rel, digest: hash, size: content.length });
        if (storeDir) {
          const blob = path.join(storeDir, 'blobs', hash);
          try { await writeFile(blob, content, { flag: 'wx' }); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            await regular(blob);
            if (digest(await readFile(blob)) !== hash) throw new Error('Stored deck asset is corrupted.');
          }
        }
      }
    };
    await walk(slideDir, '');
    return files;
  }

  private async captureUnlocked(projectId: string, slideId: string, options: CaptureOptions): Promise<DeckVersion> {
    const { slideDir, storeDir, manifestFile } = await this.locations(projectId, slideId);
    const manifest = await this.manifest(manifestFile);
    const files = await this.scan(slideDir, storeDir);
    const hash = deckDigest(files);
    const latest = manifest.versions.at(-1);
    if (latest?.digest === hash) return publicVersion(latest);
    const version: StoredVersion = {
      id: randomUUID(), createdAt: Date.now(), ...options, digest: hash,
      files, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    };
    manifest.versions.push(version);
    const temporary = `${manifestFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest));
    await rename(temporary, manifestFile);
    return publicVersion(version);
  }

  async capture(projectId: string, slideId: string, options: CaptureOptions): Promise<DeckVersion> {
    return withDeckLock(`${this.projectsRoot}/${projectId}/${slideId}`, () => this.captureUnlocked(projectId, slideId, options));
  }

  async list(projectId: string, slideId: string): Promise<DeckVersionsResponse> {
    return withDeckLock(`${this.projectsRoot}/${projectId}/${slideId}`, async () => {
      const { slideDir, manifestFile } = await this.locations(projectId, slideId);
      const manifest = await this.manifest(manifestFile);
      return { versions: manifest.versions.map(publicVersion).reverse(), currentDigest: deckDigest(await this.scan(slideDir)) };
    });
  }

  async write(projectId: string, slideId: string, edit: () => Promise<void>): Promise<void> {
    return withDeckLock(`${this.projectsRoot}/${projectId}/${slideId}`, async () => {
      await this.captureUnlocked(projectId, slideId, { reason: 'before-edit' });
      await edit();
      await this.captureUnlocked(projectId, slideId, { reason: 'after-edit' });
    });
  }

  async restore(projectId: string, slideId: string, versionId: string, expectedDigest: string,
    validate: (source: string, slideDir: string) => Promise<unknown>): Promise<DeckVersion> {
    return withDeckLock(`${this.projectsRoot}/${projectId}/${slideId}`, async () => {
      if (!ID.test(versionId) || !SHA.test(expectedDigest)) throw new Error('Invalid version or expected digest.');
      const { slideDir, storeDir, manifestFile } = await this.locations(projectId, slideId);
      const version = (await this.manifest(manifestFile)).versions.find(entry => entry.id === versionId);
      if (!version) throw new Error('Deck version not found.');
      if (deckDigest(await this.scan(slideDir)) !== expectedDigest) throw new Error('DECK_VERSION_CONFLICT: Deck changed; refresh history before restoring.');
      const stage = path.join(path.dirname(slideDir), `.restore-${randomUUID()}`);
      const backup = `${stage}-previous`;
      await mkdir(stage);
      try {
        for (const file of version.files) {
          const blob = path.join(storeDir, 'blobs', file.digest);
          await regular(blob);
          const content = await readFile(blob);
          if (content.length !== file.size || digest(content) !== file.digest) throw new Error('Deck version asset integrity check failed.');
          const target = path.join(stage, file.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        await validate(await readFile(path.join(stage, 'index.tsx'), 'utf8'), stage);
        // Preserve the entire current version before replacing any live file.
        await this.captureUnlocked(projectId, slideId, { reason: 'before-edit' });
        if (deckDigest(await this.scan(slideDir)) !== expectedDigest) throw new Error('DECK_VERSION_CONFLICT: Deck changed during restore.');
        // Preserve editor/runtime dotfiles even though they are not versioned content.
        const preserveHidden = async (current: string, target: string): Promise<void> => {
          for (const entry of await readdir(current, { withFileTypes: true })) {
            const from = path.join(current, entry.name);
            const to = path.join(target, entry.name);
            if (entry.name.startsWith('.')) await cp(from, to, { recursive: true, dereference: false });
            else if (entry.isDirectory()) {
              await mkdir(to, { recursive: true });
              await regular(to, true);
              await preserveHidden(from, to);
            }
          }
        };
        await preserveHidden(slideDir, stage);
        await rename(slideDir, backup);
        let swapped = false;
        let restored: DeckVersion;
        try {
          await rename(stage, slideDir);
          swapped = true;
          restored = await this.captureUnlocked(projectId, slideId, { reason: 'restore', restoredFrom: versionId });
        } catch (error) {
          if (swapped) await rm(slideDir, { recursive: true });
          await rename(backup, slideDir);
          throw error;
        }
        await rm(backup, { recursive: true });
        return restored;
      } finally { await rm(stage, { recursive: true, force: true }); }
    });
  }
}
