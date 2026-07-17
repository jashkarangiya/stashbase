/**
 * Folder-relative path policy shared by filesystem, HTTP, upload, and MCP
 * write paths. Absolute/platform path semantics stay in filesystem-path.ts;
 * this module owns only the POSIX-spelled protocol path inside one folder.
 */
import { isCloudPlaceholderName, isIndexExcludedDirName } from './indexable.ts';

export interface FolderRelativePathOptions {
  /** Prefix used in validation errors. */
  label?: string;
  /** Reject app-owned, placeholder, and indexing-excluded path segments. */
  writable?: boolean;
  /** Allow real user filenames containing quotes; callers opt in per route. */
  allowQuotes?: boolean;
}

export function normalizeFolderRelativePath(
  input: string,
  options: FolderRelativePathOptions = {},
): string {
  const label = options.label ?? 'path';
  if (typeof input !== 'string') throw new Error(`${label} required`);
  if (input.startsWith('/') || input.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new Error(`${label} must be relative to the folder`);
  }
  let normalized = input.replace(/\\/g, '/').replace(/\/+/g, '/');
  normalized = normalized.replace(/\/$/, '');
  if (!normalized) {
    throw new Error(`${label} required`);
  }
  if (/[\x00-\x1f]/.test(normalized) || (!options.allowQuotes && /['"]/.test(normalized))) {
    throw new Error(`${label} contains invalid characters`);
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`${label} contains an invalid segment`);
    }
    if (!options.writable) continue;
    if (isCloudPlaceholderName(segment)) {
      throw new Error(`${label} points to an iCloud placeholder; download the file locally first`);
    }
    if (segment === '.stashbase' || segment.startsWith('.stashbase-')) {
      throw new Error(`${label} cannot write into .stashbase`);
    }
    if (isIndexExcludedDirName(segment)) {
      throw new Error(`${label} cannot include excluded directory "${segment}"`);
    }
  }
  return normalized;
}
