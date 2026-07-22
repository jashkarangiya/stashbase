/**
 * Atomic publication for one disk-staged import.
 *
 * The interface hides cross-device copying, cancellation cleanup, writable
 * path policy, and the much smaller text-indexing budget from HTTP routes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { normalizeFolderRelativePath } from './folder-relative-path.ts';
import { filesystemPath } from './filesystem-path.ts';
import { indexableFileSizeError } from './indexable.ts';

const PUBLICATION_RECOVERY_SUFFIX = '.publication.json';

interface FileIdentity {
  device: string;
  inode: string;
}

interface PublicationRecoveryRecord {
  schemaVersion: 1;
  pid: number;
  createdAt: number;
  stagedPath: string;
  targetPath: string;
  temporaryPath: string;
  reservation?: FileIdentity;
  committed?: true;
}

export interface PublishedImport {
  path: string;
  indexText?: string;
  indexSkipReason?: string;
}

export async function publishStagedImport(input: {
  folderRoot: string;
  relativePath: string;
  stagedPath: string;
  signal: AbortSignal;
  captureIndexText?: boolean;
}): Promise<PublishedImport> {
  normalizeFolderRelativePath(input.relativePath, {
    label: 'upload path',
    writable: true,
    allowQuotes: true,
  });
  const target = filesystemPath.resolveUnder(input.folderRoot, input.relativePath, { access: 'creatable' });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  filesystemPath.resolveUnder(input.folderRoot, input.relativePath, { access: 'creatable' });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    // The OS staging root can be on another device, so first finish the write
    // in a same-directory temporary file rather than relying on a cross-device
    // rename. Publication below never replaces a destination created meanwhile.
    await pipeline(
      fs.createReadStream(input.stagedPath),
      fs.createWriteStream(tmp, { flags: 'wx' }),
      { signal: input.signal },
    );
    if (input.signal.aborted) throw input.signal.reason ?? new Error('upload request closed');
    // `rename` replaces an existing destination on POSIX. Collision planning
    // happens before this potentially long copy, so another window/process can
    // create the target in the meantime. A same-filesystem hard link is the
    // preferred no-clobber primitive: it atomically exposes the completed inode
    // and fails with EEXIST instead of destroying user bytes.
    await publishNoClobber(tmp, target, input.stagedPath, input.signal);
    try { fs.rmSync(tmp, { force: true }); } catch { /* hidden duplicate; target is safely published */ }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort partial cleanup */ }
    throw err;
  }

  if (!input.captureIndexText) return { path: target };
  const indexSkipReason = indexableFileSizeError(target);
  if (indexSkipReason) return { path: target, indexSkipReason };
  try {
    return { path: target, indexText: await fs.promises.readFile(target, 'utf8') };
  } catch (err: unknown) {
    // Publication already succeeded. An indexing-only read failure must not
    // tell the user that the import failed and invite a duplicate retry.
    const detail = err instanceof Error ? err.message : String(err);
    return { path: target, indexSkipReason: `file was imported but could not be read for indexing: ${detail}` };
  }
}

const LINK_UNSUPPORTED_CODES = new Set([
  'EACCES',
  'EPERM',
  'EXDEV',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

async function publishNoClobber(
  tmp: string,
  target: string,
  stagedPath: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await fs.promises.link(tmp, target);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!code || !LINK_UNSUPPORTED_CODES.has(code)) throw err;
    await publishWithoutHardLinks(tmp, target, stagedPath, signal);
  }
}

/** exFAT/FAT and some network filesystems cannot create hard links. Reserve
 * the target with `wx`, record its identity, and stream the already-complete
 * same-directory temporary through that owned handle. This is the portable
 * no-clobber primitive: Node's Windows rename replaces an existing target,
 * so it cannot safely commit the temporary. The durable record distinguishes
 * an abandoned partial reservation from a synced committed target. */
async function publishWithoutHardLinks(
  tmp: string,
  target: string,
  stagedPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('upload request closed');
  const recordPath = `${stagedPath}${PUBLICATION_RECOVERY_SUFFIX}`;
  const record: PublicationRecoveryRecord = {
    schemaVersion: 1,
    pid: process.pid,
    createdAt: Date.now(),
    stagedPath,
    targetPath: target,
    temporaryPath: tmp,
  };
  await appendRecoveryRecord(recordPath, record, 'wx');

  let reservation: FileIdentity | undefined;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(target, 'wx');
    reservation = identityForStat(await handle.stat());
    await appendRecoveryRecord(recordPath, { ...record, reservation }, 'a');
    if (signal.aborted) throw signal.reason ?? new Error('upload request closed');
    await pipeline(
      fs.createReadStream(tmp),
      handle.createWriteStream({ autoClose: true, flush: true }),
      { signal },
    );
    handle = undefined;
    if (signal.aborted) throw signal.reason ?? new Error('upload request closed');

    const publishedIdentity = identityForStat(await fs.promises.stat(target));
    if (!sameIdentity(publishedIdentity, reservation)) {
      const collision = new Error(`upload target changed during publication: ${target}`) as NodeJS.ErrnoException;
      collision.code = 'EEXIST';
      throw collision;
    }
    await appendRecoveryRecord(recordPath, { ...record, reservation, committed: true }, 'a');
  } catch (err: unknown) {
    try { await handle?.close(); } catch { /* continue identity-safe cleanup */ }
    let cleanupComplete = true;
    if (reservation) {
      try { await removeIfIdentityMatches(target, reservation); }
      catch { cleanupComplete = false; }
    }
    if (cleanupComplete) {
      try { await fs.promises.rm(recordPath, { force: true }); } catch { /* startup recovery will retry */ }
    }
    throw err;
  }

  try { await fs.promises.rm(recordPath, { force: true }); } catch { /* committed stream is recovery-safe */ }
}

async function appendRecoveryRecord(
  recordPath: string,
  record: PublicationRecoveryRecord,
  flag: 'wx' | 'a',
): Promise<void> {
  const handle = await fs.promises.open(recordPath, flag, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfIdentityMatches(target: string, identity: FileIdentity): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(target); }
  catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw err;
  }
  if (sameIdentity(identityForStat(stat), identity)) {
    await fs.promises.rm(target, { force: true });
  }
}

/** Startup recovery for one dead upload owner's fallback publication. A
 * matching recorded reservation is incomplete and removed. A committed
 * stream, different identity, or target whose identity was never durably
 * recorded is preserved because recovery cannot prove that it owns the path. */
export function recoverInterruptedPublication(recordPath: string): void {
  const record = readRecoveryRecord(recordPath);
  validateRecoveryRecord(recordPath, record);
  if (record.committed) {
    // The owned target was fully written and synced before this marker.
  } else if (record.reservation) {
    try {
      const targetIdentity = identityForStat(fs.statSync(record.targetPath));
      if (sameIdentity(targetIdentity, record.reservation)) {
        fs.rmSync(record.targetPath, { force: true });
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }
  fs.rmSync(record.temporaryPath, { force: true });
  fs.rmSync(recordPath, { force: true });
}

function readRecoveryRecord(recordPath: string): PublicationRecoveryRecord {
  let latest: PublicationRecoveryRecord | null = null;
  for (const line of fs.readFileSync(recordPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const candidate = JSON.parse(line) as unknown;
      if (isRecoveryRecord(candidate)) latest = candidate;
    } catch {
      // Records are append-only JSON lines. A process crash can truncate only
      // the final line; the previous complete line remains authoritative.
    }
  }
  if (!latest) throw new Error(`invalid import publication recovery record: ${recordPath}`);
  return latest;
}

function isRecoveryRecord(value: unknown): value is PublicationRecoveryRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PublicationRecoveryRecord>;
  return record.schemaVersion === 1
    && Number.isSafeInteger(record.pid) && (record.pid ?? 0) > 0
    && typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    && typeof record.stagedPath === 'string'
    && typeof record.targetPath === 'string'
    && typeof record.temporaryPath === 'string'
    && (record.committed === undefined || (record.committed === true && record.reservation !== undefined))
    && (record.reservation === undefined || (
      typeof record.reservation?.device === 'string'
      && typeof record.reservation?.inode === 'string'
    ));
}

function validateRecoveryRecord(recordPath: string, record: PublicationRecoveryRecord): void {
  if (path.resolve(recordPath) !== path.resolve(`${record.stagedPath}${PUBLICATION_RECOVERY_SUFFIX}`)) {
    throw new Error('import publication recovery path mismatch');
  }
  if (!path.isAbsolute(record.targetPath) || !path.isAbsolute(record.temporaryPath)) {
    throw new Error('import publication recovery paths must be absolute');
  }
  if (path.dirname(record.targetPath) !== path.dirname(record.temporaryPath)) {
    throw new Error('import publication temporary must share the target directory');
  }
  const temporaryName = path.basename(record.temporaryPath);
  const expectedPrefix = `.${path.basename(record.targetPath)}.${record.pid}.`;
  if (!temporaryName.startsWith(expectedPrefix) || !temporaryName.endsWith('.tmp')) {
    throw new Error('import publication temporary identity mismatch');
  }
}

function identityForStat(stat: fs.Stats): FileIdentity {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}
