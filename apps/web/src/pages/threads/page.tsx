import { useNavigate, useParams } from 'react-router';
import { ChatPanel } from '@/components/chat';
import { useThreadList } from './use-thread-list';

export function ThreadsPage() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const { updateThread } = useThreadList();
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
