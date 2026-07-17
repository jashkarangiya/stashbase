import { useCallback, useRef } from 'react';
import { api } from '../api';
import type { Action, CascadeDecision, CascadePrompt } from './state';

type Dispatch = (action: Action) => void;

export interface ToastOptions {
  level?: 'info' | 'success' | 'warning' | 'error';
  ttl?: number | null;
  action?: { label: string; onClick: () => void };
}

/** Owns the single-tracked dialogs and transient toast protocol. */
export function useFeedbackActions(dispatch: Dispatch) {
  const cascadeResolveRef = useRef<((decision: CascadeDecision) => void) | null>(null);
  const modalResolveRef = useRef<((value: boolean) => void) | null>(null);
  const toastSeq = useRef(0);

  const askCascade = useCallback((prompt: CascadePrompt): Promise<CascadeDecision> => {
    return new Promise<CascadeDecision>((resolve) => {
      if (cascadeResolveRef.current) cascadeResolveRef.current('cancel');
      cascadeResolveRef.current = resolve;
      dispatch({ type: 'CASCADE_PROMPT', prompt });
    });
  }, [dispatch]);

  const resolveCascadePrompt = useCallback((decision: CascadeDecision) => {
    const resolve = cascadeResolveRef.current;
    cascadeResolveRef.current = null;
    dispatch({ type: 'CASCADE_PROMPT', prompt: null });
    resolve?.(decision);
  }, [dispatch]);

  const showAlert = useCallback((message: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      modalResolveRef.current?.(false);
      modalResolveRef.current = () => resolve();
      dispatch({ type: 'MODAL_OPEN', request: { type: 'alert', message } });
    });
  }, [dispatch]);

  const askConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      modalResolveRef.current?.(false);
      modalResolveRef.current = resolve;
      dispatch({ type: 'MODAL_OPEN', request: { type: 'confirm', message } });
    });
  }, [dispatch]);

  const resolveModal = useCallback((value: boolean) => {
    const resolve = modalResolveRef.current;
    modalResolveRef.current = null;
    dispatch({ type: 'MODAL_CLOSE' });
    resolve?.(value);
  }, [dispatch]);

  const toast = useCallback((message: string, opts?: ToastOptions): string => {
    const level = opts?.level ?? 'info';
    const defaultTtl = level === 'error' ? null : level === 'warning' ? 5000 : 3000;
    const id = `toast-${++toastSeq.current}`;
    dispatch({
      type: 'TOAST_ADD',
      toast: {
        id,
        level,
        message,
        action: opts?.action,
        ttl: opts?.ttl !== undefined ? opts.ttl : defaultTtl,
      },
    });
    return id;
  }, [dispatch]);

  const dismissToast = useCallback((id: string) => {
    dispatch({ type: 'TOAST_DISMISS', id });
  }, [dispatch]);

  const clearToasts = useCallback(() => {
    dispatch({ type: 'TOAST_CLEAR' });
  }, [dispatch]);

  const askCascadeForRename = useCallback(async (
    kind: 'file' | 'folder',
    oldPath: string,
    newPath: string,
  ): Promise<boolean | null> => {
    try {
      const preview = await api.renamePreview(kind, oldPath, newPath);
      if (preview.files === 0) return true;
      const decision = await askCascade({
        kind,
        oldPath,
        newPath,
        files: preview.files,
        links: preview.links,
      });
      if (decision === 'cancel') return null;
      return decision === 'update';
    } catch (err) {
      console.warn(`[${kind} rename] preview failed:`, err);
      return true;
    }
  }, [askCascade]);

  return {
    askCascadeForRename,
    askConfirm,
    clearToasts,
    dismissToast,
    resolveCascadePrompt,
    resolveModal,
    showAlert,
    toast,
  };
}

