import { FILE_MIME, FOLDER_MIME } from './dragMime';

export type DropSurface = 'knowledge-base' | 'agent-context';

export interface DragPayloadKinds {
  osFiles: boolean;
  internalFile: boolean;
  internalFolder: boolean;
}

export function dragPayloadKinds(dt: DataTransfer): DragPayloadKinds {
  return {
    osFiles: dt.types.includes('Files'),
    internalFile: dt.types.includes(FILE_MIME),
    internalFolder: dt.types.includes(FOLDER_MIME),
  };
}

export function acceptsKnowledgeBaseDrop(dt: DataTransfer): boolean {
  const k = dragPayloadKinds(dt);
  return k.osFiles || k.internalFile || k.internalFolder;
}

export function acceptsAgentContextDrop(dt: DataTransfer): boolean {
  const k = dragPayloadKinds(dt);
  return k.osFiles || k.internalFile;
}

export function describeDrop(surface: DropSurface, kinds: DragPayloadKinds): string {
  if (surface === 'agent-context') {
    if (kinds.osFiles) return 'external files become transient agent attachments';
    if (kinds.internalFile) return 'folder files become agent context references';
    return 'unsupported agent drop';
  }
  if (kinds.internalFile || kinds.internalFolder) return 'internal tree drag moves or reorders existing files';
  if (kinds.osFiles) return 'external files are uploaded; external folders are expanded before upload';
  return 'unsupported knowledge-base drop';
}
