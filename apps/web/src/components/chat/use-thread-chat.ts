import { useCallback, useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import type {
  MessagePage,
  RunInput,
  ThreadSnapshot,
  ThreadSummary,
  ChatUsage,
  ToolInteraction,
  ToolResponse,
  ThreadBackgroundTask,
  ThreadCommandSession,
  ThreadGoal,
} from '@aime/shared/threads';
import { chatApi, ChatApiError } from './api';
import { mergeMessages } from './messages';

export function useThreadChat(
  threadId: string,
  onThreadUpdated?: (thread: ThreadSummary) => void,
) {
  const [thread, setThread] = useState<ThreadSummary | null>(null);
  const [connected, setConnected] = useState(false);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const [backgroundTasks, setBackgroundTasks] = useState<
    ThreadBackgroundTask[]
  >([]);
  const [backgroundTasksError, setBackgroundTasksError] =
    useState<ThreadSnapshot<UIMessage>['backgroundTasksError']>(null);
  const [commandSessions, setCommandSessions] = useState<
    ThreadCommandSession[]
  >([]);
  const [toolInteractions, setToolInteractions] = useState<ToolInteraction[]>(
    [],
  );
  const [error, setError] = useState<unknown>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [history, setHistory] = useState<MessagePage<UIMessage> | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const changeCallback = useRef(onThreadUpdated);
  const lastSummary = useRef('');
  useEffect(() => {
    changeCallback.current = onThreadUpdated;
  }, [onThreadUpdated]);
  const updateThread = useCallback((value: ThreadSummary) => {
    setThread(value);
    const signature = JSON.stringify(value);
    if (signature !== lastSummary.current) {
      lastSummary.current = signature;
      changeCallback.current?.(value);
    }
  }, []);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    let receivedSnapshot = false;
    let recovering = false;
    let recoveryVersion = 0;
    let recoveredMessages: UIMessage[] = [];
    const controller = new AbortController();
    // Establish history before subscribing; the initial SSE snapshot fills any intervening gap.
    void chatApi
      .history(threadId, 0, undefined, controller.signal)
      .then((page) => {
        if (disposed) return;
        setHistory(page);
        setMessages(page.messages);
        source = new EventSource(`/api/threads/${threadId}/messages`);
        const receive = (event: Event) => {
          if (disposed) return;
          const snapshot = JSON.parse(
            (event as MessageEvent).data,
          ) as ThreadSnapshot<UIMessage>;
          if (snapshot.thread.error === 'THREAD_NOT_FOUND') {
            source?.close();
            setConnected(false);
            setError(new ChatApiError('THREAD_NOT_FOUND'));
            return;
          }
          setConnected(true);
          setError(null);
          updateThread(snapshot.thread);
          setActiveMessageId(snapshot.activeMessageId);
          setUsage(snapshot.usage ?? null);
          setGoal(snapshot.goal ?? null);
          setBackgroundTasks(snapshot.backgroundTasks ?? []);
          setCommandSessions(snapshot.commandSessions ?? []);
          setBackgroundTasksError(snapshot.backgroundTasksError ?? null);
          setToolInteractions(snapshot.toolInteractions ?? []);
          if (recovering)
            recoveredMessages = mergeMessages(
              recoveredMessages,
              snapshot.messages,
              false,
              snapshot.removedMessageIds,
            );
          setMessages((current) =>
            mergeMessages(
              current,
              snapshot.messages,
              false,
              snapshot.removedMessageIds,
            ),
          );
        };
        source.addEventListener('snapshot', (event) => {
          if (!receivedSnapshot) {
            receivedSnapshot = true;
            receive(event);
            return;
          }
          // Refresh the bounded history window after a long disconnect, overlaying live updates.
          recovering = true;
          recoveredMessages = [];
          const version = ++recoveryVersion;
          receive(event);
          void chatApi
            .history(threadId, 0, undefined, controller.signal)
            .then((page) => {
              if (disposed || version !== recoveryVersion) return;
              setHistory(page);
              setMessages(mergeMessages(page.messages, recoveredMessages));
              recovering = false;
            })
            .catch((cause) => {
              if (!disposed && version === recoveryVersion) {
                recovering = false;
                setError(cause);
              }
            });
        });
        source.addEventListener('update', receive);
        source.addEventListener('expired', () => {
          source?.close();
          setConnected(false);
          setError(new ChatApiError('UNAUTHORIZED'));
        });
        source.addEventListener('revoked', (event) => {
          source?.close();
          recoveryVersion++;
          setConnected(false);
          setMessages([]);
          setThread(null);
          setUsage(null);
          setGoal(null);
          setBackgroundTasks([]);
          setCommandSessions([]);
          setBackgroundTasksError(null);
          setToolInteractions([]);
          setHistory(null);
          const { code } = JSON.parse((event as MessageEvent).data || '{}') as {
            code?: string;
          };
          setError(
            new ChatApiError(
              code === 'THREAD_NOT_FOUND' ? code : 'PROJECT_NOT_FOUND',
            ),
          );
        });
        source.onerror = () => {
          if (!disposed) {
            setConnected(false);
            setError(new TypeError('Disconnected'));
          }
        };
      })
      .catch((cause) => {
        if (!disposed) setError(cause);
      });
    return () => {
      disposed = true;
      controller.abort();
      source?.close();
    };
  }, [threadId, setMessages, updateThread]);

  async function send(input: RunInput) {
    setSubmitting(true);
    try {
      updateThread(await chatApi.run(threadId, input));
    } finally {
      setSubmitting(false);
    }
  }

  async function loadEarlier() {
    if (!history?.hasMore || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const page = await chatApi.history(
        threadId,
        history.page + 1,
        history.anchor,
      );
      setMessages((current) => mergeMessages(current, page.messages, true));
      setHistory(page);
    } finally {
      setLoadingHistory(false);
    }
  }

  return {
    thread,
    usage,
    goal,
    clearGoal: async () => {
      await chatApi.clearGoal(threadId);
      setGoal(null);
    },
    backgroundTasks,
    commandSessions,
    backgroundTasksError,
    toolInteractions,
    respondToTool: async (interactionId: string, response: ToolResponse) => {
      await chatApi.respondToTool(threadId, interactionId, response);
    },
    messages,
    connected,
    error,
    activeMessageId,
    send,
    continueRun: async () => {
      setSubmitting(true);
      try {
        updateThread(await chatApi.continue(threadId));
      } finally {
        setSubmitting(false);
      }
    },
    loadEarlier,
    hasEarlier: history?.hasMore ?? false,
    loadingHistory,
    sending: submitting,
  };
}
