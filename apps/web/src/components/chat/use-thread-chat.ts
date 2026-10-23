import { useSpeechPlayback } from '@/components/audio/use-speech-playback';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import type {
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
import type {
  ChatTurnDetail,
  ChatTurnPage,
  ChatTurnSnapshot,
  ChatTurnSummary,
} from '@aime/shared/chat-turns';
import { mergeTurns } from './turns';
import { useAuthSession } from '@/features/auth/session-context';
import { SharedEventSource } from '@/components/realtime/event-source';

export function useThreadChat(
  threadId: string,
  onThreadUpdated?: (thread: ThreadSummary) => void,
) {
  const sessionId = useAuthSession().data?.session.id;
  const speech = useSpeechPlayback(threadId);
  const {
    receive: receiveSpeech,
    stop: stopSpeech,
    unlock: unlockSpeech,
  } = speech;
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
  const [history, setHistory] = useState<Pick<
    ChatTurnPage,
    'cursor' | 'hasMore'
  > | null>(null);
  const historyRequest = useRef(false);
  const historyVersion = useRef(0);
  const session = useRef<AbortController | null>(null);
  const [canContinue, setCanContinue] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
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
  const [turns, setTurns] = useState<ChatTurnSummary[]>([]);
  const [details, setDetails] = useState<Map<string, ChatTurnDetail>>(
    () => new Map(),
  );
  const detailCache = useRef(new Map<string, ChatTurnDetail>());
  const detailRequests = useRef(new Map<string, Promise<ChatTurnDetail>>());
  // Workspace previews can resolve complete tool parts only after the user opens details.
  const messages = useMemo(
    () =>
      turns.flatMap(
        (turn) =>
          details.get(turn.id)?.messages ??
          [turn.user, turn.assistant].filter(
            (item): item is UIMessage => !!item,
          ),
      ),
    [turns, details],
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    session.current = controller;
    const source = new SharedEventSource(
      `/api/threads/${threadId}/messages?view=summary`,
      sessionId,
    );
    const receive = (event: Event) => {
      if (controller.signal.aborted) return;
      const snapshot = JSON.parse(
        (event as MessageEvent).data,
      ) as ChatTurnSnapshot;
      if (snapshot.thread.error === 'THREAD_NOT_FOUND') {
        source.close();
        stopSpeech();
        setConnected(false);
        setError(new ChatApiError('THREAD_NOT_FOUND'));
        return;
      }
      setConnected(true);
      setError(null);
      updateThread(snapshot.thread);
      setActiveMessageId(snapshot.activeMessageId);
      setActiveTurnId(snapshot.activeTurnId);
      setCanContinue(snapshot.canContinue);
      setUsage(snapshot.usage ?? null);
      setGoal(snapshot.goal ?? null);
      setBackgroundTasks(snapshot.backgroundTasks ?? []);
      setCommandSessions(snapshot.commandSessions ?? []);
      setBackgroundTasksError(snapshot.backgroundTasksError ?? null);
      setToolInteractions(snapshot.toolInteractions ?? []);
      if (snapshot.history) {
        historyVersion.current++;
        setHistory(snapshot.history);
        setTurns(snapshot.turns);
      } else
        setTurns((current) =>
          mergeTurns(current, snapshot.turns, false, snapshot.removedTurnIds),
        );
    };
    source.addEventListener('snapshot', receive);
    source.addEventListener('update', receive);
    source.addEventListener('speech', receiveSpeech);
    const revoke = (code: string) => {
      controller.abort();
      source.close();
      stopSpeech();
      setConnected(false);
      setTurns([]);
      setDetails(new Map());
      detailCache.current.clear();
      setThread(null);
      setUsage(null);
      setGoal(null);
      setBackgroundTasks([]);
      setCommandSessions([]);
      setBackgroundTasksError(null);
      setToolInteractions([]);
      setHistory(null);
      setCanContinue(false);
      setError(new ChatApiError(code));
    };
    source.addEventListener('expired', () => revoke('UNAUTHORIZED'));
    source.addEventListener('revoked', (event) => {
      const { code } = JSON.parse((event as MessageEvent).data || '{}') as {
        code?: string;
      };
      revoke(code === 'THREAD_NOT_FOUND' ? code : 'PROJECT_NOT_FOUND');
    });
    source.onerror = () => {
      if (!controller.signal.aborted) {
        stopSpeech();
        setConnected(false);
        setError(new TypeError('Disconnected'));
      }
    };
    return () => {
      controller.abort();
      source.close();
      stopSpeech();
    };
  }, [threadId, sessionId, updateThread, receiveSpeech, stopSpeech]);

  const loadDetails = useCallback(
    async (turn: ChatTurnSummary) => {
      const cached = detailCache.current.get(turn.id);
      if (cached?.revision === turn.revision) return cached;
      const pending = detailRequests.current.get(turn.id);
      if (pending) return pending;
      const controller = session.current;
      if (!controller || controller.signal.aborted)
        throw new Error('Chat is closed');
      const request = chatApi
        .turn(threadId, turn.id, turn.cursor, controller.signal)
        .then((detail) => {
          if (!controller.signal.aborted) {
            detailCache.current.set(turn.id, detail);
            setDetails((current) => new Map(current).set(turn.id, detail));
          }
          return detail;
        })
        .finally(() => detailRequests.current.delete(turn.id));
      detailRequests.current.set(turn.id, request);
      return request;
    },
    [threadId],
  );

  async function send(input: RunInput) {
    unlockSpeech();
    setSubmitting(true);
    try {
      updateThread(await chatApi.run(threadId, input));
    } finally {
      setSubmitting(false);
    }
  }

  const loadEarlier = useCallback(async () => {
    if (!history?.cursor || historyRequest.current) return;
    const controller = session.current;
    if (!controller || controller.signal.aborted) return;
    historyRequest.current = true;
    const version = historyVersion.current;
    setLoadingHistory(true);
    try {
      const page = await chatApi.turnHistory(
        threadId,
        history.cursor,
        controller.signal,
      );
      if (controller.signal.aborted || version !== historyVersion.current)
        return;
      setTurns((current) => mergeTurns(current, page.turns, true));
      setHistory(page);
    } finally {
      historyRequest.current = false;
      if (!controller.signal.aborted) setLoadingHistory(false);
    }
  }, [threadId, history]);

  return {
    speech,
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
    turns,
    details,
    loadDetails,
    canContinue,
    activeTurnId,
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
