import { useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { FilePreview } from '@aime/shared/files';
import { fileErrorKey } from './api';
import { withinPath } from './state';
import type { WorkspaceFileClient } from './workspace-client';

export type FileEdit = {
  base: FilePreview;
  text: string;
  saving: boolean;
  error?: ReturnType<typeof fileErrorKey>;
};

function findDraft(drafts: Record<string, FileEdit>, path: string) {
  return Object.hasOwn(drafts, path) ? drafts[path] : undefined;
}

export function useFileEdits(client: WorkspaceFileClient) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, FileEdit>>({});
  const pending = useRef(new Set<string>());
  const unsaved = Object.values(drafts).some(
    (draft) => draft.saving || draft.text !== draft.base.text,
  );
  useBlocker({
    disabled: !unsaved,
    enableBeforeUnload: unsaved,
    shouldBlockFn: () =>
      pending.current.size > 0 || !window.confirm(t('files.leaveEdits')),
  });
  function discard(path: string) {
    if (pending.current.has(path)) return;
    setDrafts((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([key]) => key !== path),
      ),
    );
  }
  return {
    drafts,
    get: (path: string) => findDraft(drafts, path),
    isDirty: (path: string) => {
      const draft = findDraft(drafts, path);
      return !!draft && draft.text !== draft.base.text;
    },
    start(data: FilePreview) {
      if (data.kind !== 'text' || data.truncated || !data.version) return;
      setDrafts((previous) => ({
        ...previous,
        [data.path]: findDraft(previous, data.path) ?? {
          base: data,
          text: data.text ?? '',
          saving: false,
        },
      }));
    },
    change(path: string, text: string) {
      setDrafts((previous) => {
        const draft = findDraft(previous, path);
        if (!draft || draft.saving) return previous;
        return { ...previous, [path]: { ...draft, text, error: undefined } };
      });
    },
    async save(path: string) {
      const draft = findDraft(drafts, path);
      if (
        !draft?.base.version ||
        draft.text === draft.base.text ||
        pending.current.has(path)
      )
        return;
      pending.current.add(path);
      setDrafts((previous) => ({
        ...previous,
        [path]: { ...draft, saving: true, error: undefined },
      }));
      try {
        const base = await client.save({
          path,
          text: draft.text,
          version: draft.base.version,
        });
        setDrafts((previous) => ({
          ...previous,
          [path]: { base, text: base.text ?? '', saving: false },
        }));
        toast.success(t('files.contentSaved'));
      } catch (cause) {
        const error = fileErrorKey(cause);
        setDrafts((previous) => ({
          ...previous,
          [path]: { ...draft, saving: false, error },
        }));
        toast.error(t(error));
      } finally {
        pending.current.delete(path);
      }
    },
    discard,
    isSaving(path: string) {
      return [...pending.current].some((key) => withinPath(key, path));
    },
    move(from: string, to?: string) {
      setDrafts((previous) =>
        Object.fromEntries(
          Object.entries(previous).flatMap(([path, draft]) => {
            if (!withinPath(path, from)) return [[path, draft]];
            if (!to) return [];
            const next = to + path.slice(from.length);
            return [[next, { ...draft, base: { ...draft.base, path: next } }]];
          }),
        ),
      );
    },
  };
}
export type FileEdits = ReturnType<typeof useFileEdits>;
