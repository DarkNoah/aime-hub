import type { UIMessage, ChatTransport } from 'ai';
import type {
  ChatSettings,
  MessagePage,
  RunInput,
  ThreadList,
  ThreadSummary,
} from '@aime/shared/threads';

export class ChatApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export async function chatRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api/threads${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ChatApiError(data.code ?? 'CHAT_FAILED');
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const chatApi = {
  list: (page = 0, signal?: AbortSignal) =>
    chatRequest<ThreadList>(`?page=${page}`, { signal }),
  create: (settings: ChatSettings) =>
    chatRequest<ThreadSummary>('', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  update: (id: string, input: Partial<ChatSettings> & { title?: string }) =>
    chatRequest<ThreadSummary>(`/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  remove: (id: string) => chatRequest<void>(`/${id}`, { method: 'DELETE' }),
  run: (id: string, input: RunInput) =>
    chatRequest<ThreadSummary>(`/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  history: (id: string, page = 0, anchor?: string, signal?: AbortSignal) =>
    chatRequest<MessagePage<UIMessage>>(
      `/${id}/history?page=${page}${anchor ? `&anchor=${encodeURIComponent(anchor)}` : ''}`,
      { signal },
    ),
  abort: (id: string) =>
    chatRequest<ThreadSummary>(`/${id}/abort`, { method: 'POST' }),
  resume: (id: string) =>
    chatRequest<ThreadSummary>(`/${id}/resume`, { method: 'POST' }),
  cancel: (id: string, messageId: string) =>
    chatRequest<ThreadSummary>(`/${id}/queue/${messageId}`, {
      method: 'DELETE',
    }),
  preferences: () => chatRequest<ChatSettings>('/preferences'),
  savePreferences: (settings: ChatSettings) =>
    chatRequest<ChatSettings>('/preferences', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
};

// HTTP acknowledges submission; an independent SSE subscription is authoritative for execution.
// Returning an empty stream lets useChat send another message while the server queues work.
export function createThreadTransport(
  onAccepted: (thread: ThreadSummary) => void,
): ChatTransport<UIMessage> {
  return {
    async sendMessages({ chatId, messages, body }) {
      const message = messages[messages.length - 1];
      if (message.role !== 'user') throw new ChatApiError('VALIDATION_ERROR');
      const thread = await chatApi.run(chatId, {
        ...body,
        id: message.id,
        parts: message.parts,
      } as RunInput);
      onAccepted(thread);
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    },
    async reconnectToStream() {
      return null;
    },
  };
}

export function chatErrorKey(error: unknown) {
  const code =
    error instanceof ChatApiError
      ? error.code
      : typeof error === 'string'
        ? error
        : '';
  switch (code) {
    case 'UNAUTHORIZED':
      return 'errors.sessionExpired';
    case 'FORBIDDEN':
      return 'errors.forbidden';
    case 'THREAD_NOT_FOUND':
      return 'chat.errors.notFound';
    case 'MODEL_NOT_CONFIGURED':
      return 'chat.errors.noModel';
    case 'MODEL_UNAVAILABLE':
      return 'chat.errors.modelUnavailable';
    case 'MODEL_NO_IMAGES':
      return 'chat.errors.noImages';
    case 'RUN_INTERRUPTED':
      return 'chat.errors.interrupted';
    case 'THREAD_BUSY':
      return 'chat.errors.busy';
    case 'THREAD_STOPPING':
      return 'chat.errors.stopping';
    case 'QUEUE_FULL':
      return 'chat.errors.queueFull';
    case 'MESSAGE_TOO_LARGE':
    case 'VALIDATION_ERROR':
      return 'chat.errors.validation';
    default:
      return error instanceof TypeError
        ? 'errors.network'
        : 'chat.errors.failed';
  }
}
