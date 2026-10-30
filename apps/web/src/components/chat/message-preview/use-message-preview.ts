import { useCallback, useState } from 'react';
import type { UIMessage } from 'ai';
import {
  resolveMessagePart,
  selectMessagePart,
  type MessagePreviewSelection,
  type PreviewPart,
} from './selection';

/** Keep previews attached to live tool call IDs regardless of their presentation. */
export function useMessagePreviewController(messages: UIMessage[]) {
  const [selection, setSelection] = useState<MessagePreviewSelection | null>(
    null,
  );
  const open = useCallback(
    (part: PreviewPart) => {
      const selection = selectMessagePart(messages, part);
      if (!selection) return false;
      setSelection(selection);
      return true;
    },
    [messages],
  );
  const close = useCallback(() => setSelection(null), []);
  return {
    selection,
    part: resolveMessagePart(messages, selection),
    open,
    close,
  };
}
