import { useCallback, useState } from 'react';
import {
  chatDraftKey,
  clearChatDraft,
  readChatDraft,
  writeChatDraft,
  type ChatDraftScope,
} from './draft-storage';

export function useChatDraft(scope: ChatDraftScope) {
  const key = chatDraftKey(scope);
  const [draft, setDraft] = useState(() => ({ key, text: readChatDraft(key) }));
  if (draft.key !== key) setDraft({ key, text: readChatDraft(key) });

  const setText = useCallback(
    (text: string) => {
      // Persist in the input handler so an immediate refresh cannot lose an edit.
      writeChatDraft(key, text);
      setDraft({ key, text });
    },
    [key],
  );

  const clear = useCallback(
    (submittedText: string) => {
      // This must run even if sending the first message unmounts the composer.
      clearChatDraft(key, submittedText);
      setDraft((current) =>
        current.key === key && current.text === submittedText
          ? { key, text: '' }
          : current,
      );
    },
    [key],
  );

  return { text: draft.text, setText, clear };
}
