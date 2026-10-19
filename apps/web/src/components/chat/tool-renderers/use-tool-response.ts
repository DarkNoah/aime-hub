import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import type { ToolResponse } from '@aime/shared/threads';
import { chatErrorKey } from '../api';
import type { ToolInteractionProps } from '../chat-tool-interaction';

type ResponseAction =
  | {
      action: 'resume';
      data: Extract<ToolResponse, { action: 'resume' }>['data'];
    }
  | { action: 'approve' }
  | { action: 'decline'; reason?: string };

/** Share acknowledgement, retry IDs and duplicate-click protection across renderers. */
export function useToolResponse({
  interaction,
  disabled,
  onRespond,
}: ToolInteractionProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<ToolResponse>();
  const [error, setError] = useState<
    ReturnType<typeof chatErrorKey> | 'chat.toolInteraction.invalidJson'
  >();
  const sending = useRef(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const response = interaction?.response ?? submitted;
  const unavailable =
    disabled || pending || !!response || !interaction || !onRespond;

  async function submit(action: ResponseAction) {
    if (unavailable || sending.current || !interaction || !onRespond)
      return false;
    sending.current = true;
    setPending(true);
    setError(undefined);
    const signature = JSON.stringify(action);
    // Reuse the ID when retrying an acknowledgement lost to a disconnect.
    if (request.current?.signature !== signature)
      request.current = { signature, id: nanoid() };
    const value = { ...action, id: request.current.id } as ToolResponse;
    try {
      await onRespond(interaction.id, value);
      setSubmitted(value);
      toast.success(t('chat.toolInteraction.sent'));
      return true;
    } catch (cause) {
      const key = chatErrorKey(cause);
      setError(key);
      toast.error(t(key));
      return false;
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return { response, pending, unavailable, error, setError, submit } as const;
}
