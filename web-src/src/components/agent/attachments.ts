import type { Attachment } from './types';

/** Append new attachments, skipping any whose path is already present
 *  (re-dropping the same file is a no-op). */
export function mergeAttachments(cur: Attachment[], add: Attachment[]): Attachment[] {
  const have = new Set(cur.map((a) => a.path));
  const fresh = add.filter((a) => !have.has(a.path));
  return fresh.length ? [...cur, ...fresh] : cur;
}

/** Read an image File's natural pixel dimensions for the chip label
 *  (e.g. `2162×4000`). Resolves undefined if it isn't a decodable image. */
export function readImageDims(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(`${img.naturalWidth}×${img.naturalHeight}`); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(undefined); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

export const baseName = (p: string) => p.split('/').pop() || p;
