import { useNavigate, useParams } from 'react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatPanel } from '@/components/chat';
import { chatApi, chatErrorKey } from '@/components/chat/api';
import { LoadingState } from '@/components/loading-state';
import { useThreadList } from './use-thread-list';

export function ThreadsPage() {
  const { threadId } = useParams();
  return <ThreadPageSession key={threadId ?? 'new'} threadId={threadId} />;
}

function ThreadPageSession({ threadId }: { threadId?: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [ready, setReady] = useState(!threadId);
  const [error, setError] = useState<ReturnType<typeof chatErrorKey> | null>(
    null,
  );
  const { updateThread } = useThreadList();
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    void chatApi
      .get(threadId, controller.signal)
      .then(({ thread }) => {
        if (controller.signal.aborted) return;
        if (thread.projectId)
          navigate(`/projects/${thread.projectId}/threads/${thread.id}`, {
            replace: true,
          });
        else setReady(true);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(chatErrorKey(cause));
      });
    return () => controller.abort();
  }, [threadId, navigate]);
  if (error)
    return (
      <p role="alert" className="p-6">
        {t(error)}
      </p>
    );
  if (!ready) return <LoadingState className="p-6" />;
  return (
    <ChatPanel
      threadId={threadId}
      onThreadCreated={(thread) => {
        updateThread(thread);
        navigate(`/threads/${thread.id}`);
      }}
      onThreadUpdated={updateThread}
    />
  );
}
