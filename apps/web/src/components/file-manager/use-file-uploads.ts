import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { WorkspaceFileClient } from './workspace-client';
import { fileErrorKey } from './api';

export type UploadItem = {
  id: string;
  file: File;
  directory: string;
  progress: number;
  status: 'queued' | 'uploading' | 'finishing' | 'error' | 'cancelled';
  error?: ReturnType<typeof fileErrorKey>;
};

export function useFileUploads(
  client: WorkspaceFileClient,
  onUploaded: (directory: string) => Promise<void>,
) {
  const { t } = useTranslation();
  const [items, setItems] = useState<UploadItem[]>([]);
  const pending = useRef<UploadItem[]>([]);
  const active = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const controllers = active.current;
    return () => {
      mounted.current = false;
      pending.current = [];
      controllers.forEach((controller) => controller.abort());
    };
  }, []);

  function update(item: UploadItem, patch: Partial<UploadItem>) {
    Object.assign(item, patch);
    if (mounted.current)
      setItems((previous) =>
        previous.map((entry) => (entry.id === item.id ? { ...item } : entry)),
      );
  }
  function pump() {
    while (
      mounted.current &&
      active.current.size < 2 &&
      pending.current.length
    ) {
      const item = pending.current.shift()!;
      const controller = new AbortController();
      active.current.set(item.id, controller);
      update(item, { status: 'uploading', error: undefined, progress: 0 });
      void client
        .upload(item.directory, item.file, {
          signal: controller.signal,
          onProgress: (progress) => update(item, { progress }),
          onFinishing: () => update(item, { status: 'finishing' }),
        })
        .then(async () => {
          if (mounted.current) {
            setItems((previous) =>
              previous.filter((entry) => entry.id !== item.id),
            );
            toast.success(t('files.uploadSuccess', { name: item.file.name }), {
              duration: 3000,
            });
            await onUploaded(item.directory);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) update(item, { status: 'cancelled' });
          else {
            const key = fileErrorKey(error);
            update(item, { status: 'error', error: key });
            if (mounted.current)
              toast.error(t('files.uploadFailed', { name: item.file.name }), {
                description: t(key),
              });
          }
        })
        .finally(() => {
          active.current.delete(item.id);
          pump();
        });
    }
  }
  return {
    items,
    enqueue(files: File[], directory: string) {
      const next: UploadItem[] = files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        directory,
        status: 'queued',
        progress: 0,
      }));
      setItems((previous) => [...previous, ...next]);
      pending.current.push(...next);
      pump();
    },
    cancel(id: string) {
      pending.current = pending.current.filter((item) => item.id !== id);
      active.current.get(id)?.abort();
      setItems((previous) =>
        previous.map((item) =>
          item.id === id ? { ...item, status: 'cancelled' } : item,
        ),
      );
    },
    retry(item: UploadItem) {
      if (
        active.current.has(item.id) ||
        pending.current.some((entry) => entry.id === item.id)
      )
        return;
      const next = {
        ...item,
        status: 'queued' as const,
        progress: 0,
        error: undefined,
      };
      setItems((previous) =>
        previous.map((entry) => (entry.id === item.id ? next : entry)),
      );
      pending.current.push(next);
      pump();
    },
    clear() {
      setItems((previous) =>
        previous.filter((item) =>
          ['queued', 'uploading', 'finishing'].includes(item.status),
        ),
      );
    },
  };
}
export type FileUploadsState = ReturnType<typeof useFileUploads>;
