import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { MAX_CHAT_FILES } from '@aime/shared/threads';
import { apiErrorCode } from '@/lib/rpc';
import { filesApi, fileErrorKey } from '../file-manager/api';
import { ChatUploadQueue } from './chat-uploads';

export function useChatUploads(ensureThread: () => Promise<string>) {
  const { t } = useTranslation();
  const callbacks = {
    ensureThread,
    onError(error: unknown, file: File) {
      if (apiErrorCode(error) === 'CHAT_ATTACHMENT_LIMIT')
        toast.error(t('assets.limit', { count: MAX_CHAT_FILES }));
      else
        toast.error(t('files.uploadFailed', { name: file.name }), {
          description: t(fileErrorKey(error)),
        });
    },
    onUploaded(file: File) {
      toast.success(t('files.uploadSuccess', { name: file.name }), {
        duration: 3000,
      });
    },
  };
  const [queue] = useState(
    () =>
      new ChatUploadQueue({
        ...callbacks,
        async prepare(threadId, directory) {
          try {
            await filesApi.list(threadId, '.uploads');
          } catch (error) {
            if (apiErrorCode(error) !== 'FILE_NOT_FOUND') throw error;
            try {
              await filesApi.mutate(threadId, {
                operation: 'create',
                kind: 'directory',
                path: '.uploads',
              });
            } catch (cause) {
              if (apiErrorCode(cause) !== 'FILE_EXISTS') throw cause;
            }
          }
          await filesApi.mutate(threadId, {
            operation: 'create',
            kind: 'directory',
            path: directory,
          });
        },
        upload: filesApi.upload,
        async remove(threadId, directory) {
          try {
            await filesApi.mutate(threadId, {
              operation: 'delete',
              path: directory,
            });
          } catch (error) {
            if (apiErrorCode(error) !== 'FILE_NOT_FOUND') throw error;
          }
        },
        image: (file) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          }),
      }),
  );
  useLayoutEffect(() => {
    queue.configure(callbacks);
  });
  useEffect(() => {
    queue.resume();
    return () => queue.dispose();
  }, [queue]);
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  return {
    queue,
    items,
    blocked: items.some((item) => item.status !== 'done'),
  };
}
