import { useSpeechPlayback } from '@/components/audio/use-speech-playback';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import type {
  RunInput,
  ThreadSnapshot,
  ThreadSummary,
  ChatUsage,
  ToolInteraction,
  AskUserAnswer,
  ToolResponse,
  ThreadBackgroundTask,
  ThreadCommandSession,
  ThreadGoal,
} from '@aime/shared/threads';
import { chatApi, ChatApiError } from './api';
import type {
  ChatToolGroup,
  ChatToolGroupDetail,
  ChatTurnPage,
  ChatTurnSnapshot,
  ChatTurnSummary,
} from '@aime/shared/chat-turns';
import { mergeTurns } from './turns';
import { appendToolGroupPage } from './tool-group-pages';
import type { LoadedChatToolGroup } from './chat-tool-group';
import { useAuthSession } from '@/features/auth/session-context';
import { SharedEventSource } from '@/components/realtime/event-source';

export function useThreadChat(
  threadId: string,
  onThreadUpdated?: (thread: ThreadSummary) => void,
  { receiveSpeech: listenToSpeech = true }: { receiveSpeech?: boolean } = {},
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
  const [thinking, setThinking] = useState(false);
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
  const [groupDetails, setGroupDetails] = useState(
    () => new Map<string, LoadedChatToolGroup>(),
  );
  const groupCache = useRef(new Map<string, LoadedChatToolGroup>());
  const groupRequests = useRef(new Map<string, Promise<ChatToolGroupDetail>>());
  const groupRevisions = useRef(new Map<string, string>());
  // Workspace previews can resolve complete tool parts only after the user opens details.
  const messages = useMemo(
    () => [
      ...turns.flatMap((turn) =>
        [turn.user, turn.assistant].filter((item): item is UIMessage => !!item),
      ),
      ...[...groupDetails.values()].flatMap((group) => group.messages),
    ],
    [turns, groupDetails],
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
      setThinking(snapshot.thinking === true);
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
    if (listenToSpeech) source.addEventListener('speech', receiveSpeech);
    const revoke = (code: string) => {
      controller.abort();
      source.close();
      stopSpeech();
      setConnected(false);
      setTurns([]);
      setGroupDetails(new Map());
      groupCache.current.clear();
      groupRevisions.current.clear();
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
  }, [
    threadId,
    sessionId,
    updateThread,
    receiveSpeech,
    stopSpeech,
    listenToSpeech,
  ]);

  const loadGroupDetails = useCallback(
    async (turn: ChatTurnSummary, group: ChatToolGroup, page = 0) => {
      const key = `${turn.id}:${group.id}`;
      const cached = groupCache.current.get(key);
      const current = cached?.summaryRevision === group.revision;
      if (current && page <= cached.page) return cached;
      // A changed group starts a fresh page sequence, so pages never mix revisions.
      const nextPage = current && page === cached.page + 1 ? page : 0;
      const requestKey = `${key}:${group.revision}:${nextPage}`;
      const pending = groupRequests.current.get(requestKey);
      if (pending) return pending;
      const controller = session.current;
      if (!controller || controller.signal.aborted)
        throw new Error('Chat is closed');
      groupRevisions.current.set(key, group.revision);
      const request = (async () => {
        let result = await chatApi.toolGroup(
          threadId,
          turn.id,
          group.id,
          turn.cursor,
          nextPage,
          controller.signal,
        );
        // A live tool can change between pages even before the summary arrives.
        if (nextPage > 0 && result.revision !== cached?.revision)
          result = await chatApi.toolGroup(
            threadId,
            turn.id,
            group.id,
            turn.cursor,
            0,
            controller.signal,
          );
        const loaded: LoadedChatToolGroup = {
          ...result,
          summaryRevision: group.revision,
          messages:
            result.page > 0 && cached
              ? appendToolGroupPage(cached.messages, result.messages)
              : result.messages,
        };
        if (
          !controller.signal.aborted &&
          groupRevisions.current.get(key) === group.revision
        ) {
          groupCache.current.set(key, loaded);
          setGroupDetails((existing) => new Map(existing).set(key, loaded));
        }
        return loaded;
      })().finally(() => groupRequests.current.delete(requestKey));
      groupRequests.current.set(requestKey, request);
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
    respondToQuestions: async (
      interactionId: string,
      answers: AskUserAnswer[],
    ) => {
      await chatApi.respondToQuestions(threadId, interactionId, answers);
    },
    messages,
    turns,
    groupDetails,
    loadGroupDetails,
    canContinue,
    activeTurnId,
    connected,
    error,
    activeMessageId,
    thinking: connected && thinking,
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
