import type { ConversionFailure } from '../api';
import type { State } from './state';
import { isVisibleIndexPending, isVisibleStashing } from './state';

export interface FileReadiness {
  isIndexPending: boolean;
  isConverting: boolean;
  isTemporarilyUnsearchable: boolean;
  isStashing: boolean;
  conversionFailure: ConversionFailure | undefined;
}

export function conversionFailureMatchesTarget(failurePath: string, target: string): boolean {
  if (failurePath === target) return true;
  const slash = target.lastIndexOf('/');
  const dir = slash >= 0 ? target.slice(0, slash + 1) : '';
  const base = slash >= 0 ? target.slice(slash + 1) : target;
  return failurePath === `${dir}.${base}.md`;
}

export function getConversionFailure(s: State, path: string): ConversionFailure | undefined {
  return s.conversionFailures.find((f) => conversionFailureMatchesTarget(f.path, path));
}

export function getFileReadiness(s: State, path: string): FileReadiness {
  const isIndexPending = isVisibleIndexPending(s, path);
  const isConverting = s.pendingConversions.includes(path);
  return {
    isIndexPending,
    isConverting,
    isTemporarilyUnsearchable: isIndexPending || isConverting,
    isStashing: isVisibleStashing(s, path),
    conversionFailure: getConversionFailure(s, path),
  };
}
