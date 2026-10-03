import { useEffect, useState } from 'react';
import type { ChatSkill } from '@aime/shared/threads';
import { chatApi, chatErrorKey } from './api';

export function useChatSkills(
  enabled: boolean,
  threadId?: string,
  projectId?: string,
): {
  skills: ChatSkill[];
  error: ReturnType<typeof chatErrorKey> | undefined;
  loading: boolean;
  retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([threadId, projectId, attempt]);
  const [result, setResult] = useState<{
    key: string;
    skills: ChatSkill[];
    error?: ReturnType<typeof chatErrorKey>;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void chatApi.skills({ threadId, projectId }, controller.signal).then(
      (skills) => {
        if (!controller.signal.aborted) setResult({ key, skills });
      },
      (cause) => {
        if (!controller.signal.aborted)
          setResult({ key, skills: [], error: chatErrorKey(cause) });
      },
    );
    return () => controller.abort();
  }, [enabled, key, threadId, projectId]);

  return {
    skills: result?.key === key ? result.skills : [],
    error: result?.key === key ? result.error : undefined,
    loading: result?.key !== key,
    retry: () => setAttempt((value) => value + 1),
  };
}
