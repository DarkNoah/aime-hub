import type { UIMessage, ChatTransport } from 'ai';
import type {
  ChatSettings,
  MessagePage,
  RunInput,
  ThreadList,
  ThreadSummary,
  ThreadSnapshot,
  UpdateQueuedMessage,
  QueuedMessageDetail,
} from '@aime/shared/threads';

export class ChatApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export async function chatRequest<T>(
  path: string,
  init?: RequestInit,
  base = '/api/threads',
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
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
  list: (page = 0, signal?: AbortSignal, projectId?: string, perPage = 10) =>
    chatRequest<ThreadList>(
      `?page=${page}&perPage=${perPage}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
      { signal },
    ),
  get: (id: string, signal?: AbortSignal) =>
    chatRequest<ThreadSnapshot<UIMessage>>(`/${id}`, { signal }),
  create: (settings: ChatSettings & { projectId?: string }) =>
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
  queued: (id: string, messageId: string, signal?: AbortSignal) =>
    chatRequest<QueuedMessageDetail>(`/${id}/queue/${messageId}`, { signal }),
  updateQueued: (id: string, messageId: string, input: UpdateQueuedMessage) =>
    chatRequest<ThreadSummary>(`/${id}/queue/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  moveQueued: (id: string, messageId: string, beforeId: string | null) =>
    chatRequest<ThreadSummary>(`/${id}/queue`, {
      method: 'PATCH',
      body: JSON.stringify({ id: messageId, beforeId }),
    }),
  preferences: () => chatRequest<ChatSettings>('/preferences'),
  projectPreferences: (projectId: string) =>
    chatRequest<ChatSettings>(
      `/${projectId}/preferences`,
      undefined,
      '/api/projects',
    ),
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
    case 'PROJECT_NOT_FOUND':
      return 'projects.errors.notFound';
    case 'PROJECT_BUSY':
      return 'projects.errors.busy';
    case 'PROJECT_OWNER_REQUIRED':
      return 'projects.errors.owner';
    case 'PROJECT_USER_NOT_FOUND':
      return 'projects.errors.user';
    case 'PROJECT_MEMBER_EXISTS':
      return 'projects.errors.exists';
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
    case 'QUEUED_MESSAGE_NOT_FOUND':
      return 'chat.errors.queuedGone';
    case 'MESSAGE_TOO_LARGE':
    case 'VALIDATION_ERROR':
      return 'chat.errors.validation';
    default:
      return error instanceof TypeError
        ? 'errors.network'
        : 'chat.errors.failed';
  }
}
