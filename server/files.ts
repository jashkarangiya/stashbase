/**
 * Stable active-folder filesystem facade.
 *
 * Public functions accept a folder-relative POSIX path like `topic/note.md`.
 * The implementation is split by responsibility so path containment, on-disk
 * mutations, and sidebar listing stay independently navigable while existing
 * route and library imports continue to use this module.
 */

export { detectFormat, type FileFormat } from './format.ts';
export {
  getCurrentFolderBasename,
  isSameExistingPath,
  sanitizeFilename,
} from './file-paths.ts';
export {
  createFolder,
  createTextExclusive,
  deleteFile,
  deleteFolder,
  derivedArtifactsForSource,
  fileStatVersion,
  fileVersion,
  pathExists,
  readText,
  renameFolder,
  renameOnDisk,
  resolveAsset,
  resolveExisting,
  saveBytes,
  saveText,
  type DerivedArtifacts,
} from './active-file-operations.ts';
export {
  HIDDEN_DOT_DIRS,
  listFiles,
  listFilesAndFolders,
  listFolders,
  listIndexableTextFilesUnder,
  type FileEntry,
  type FolderEntry,
  type FolderListing,
} from './file-listing.ts';
