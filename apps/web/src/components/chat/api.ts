import type {
  ChatSettings,
  RunInput,
  ToolResponse,
  UpdateQueuedMessage,
} from '@aime/shared/threads';
import { api, apiErrorCode } from '../../lib/rpc.js';

export class ChatApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const chatApi = {
  skills: (
    scope: { threadId?: string; projectId?: string },
    signal?: AbortSignal,
  ) => api.threads.skills({ query: scope }, { signal }),
  list: (page = 0, signal?: AbortSignal, projectId?: string, perPage = 10) =>
    api.threads.list({ query: { page, perPage, projectId } }, { signal }),
  get: (threadId: string, signal?: AbortSignal) =>
    api.threads.get({ params: { threadId } }, { signal }),
  create: (settings: ChatSettings & { projectId?: string }) =>
    api.threads.create({ body: settings }),
  update: (
    threadId: string,
    input: Partial<ChatSettings> & { title?: string },
  ) => api.threads.update({ params: { threadId }, body: input }),
  remove: (threadId: string) => api.threads.remove({ params: { threadId } }),
  archived: (signal?: AbortSignal) =>
    api.threads.archived(undefined, { signal }),
  restore: (threadId: string) => api.threads.restore({ params: { threadId } }),
  removeArchived: (threadId: string) =>
    api.threads.removeArchived({ params: { threadId } }),
  run: (threadId: string, input: RunInput) =>
    api.threads.run({ params: { threadId }, body: input }),
  history: async (
    threadId: string,
    page = 0,
    anchor?: string,
    signal?: AbortSignal,
  ) => {
    const result = await api.threads.history(
      { params: { threadId }, query: { page, anchor, view: 'full' } },
      { signal },
    );
    if (!('messages' in result)) throw new Error('Expected complete history');
    return result;
  },
  turnHistory: async (
    threadId: string,
    cursor: string,
    signal?: AbortSignal,
  ) => {
    const result = await api.threads.history(
      { params: { threadId }, query: { view: 'summary', cursor } },
      { signal },
    );
    if (!('turns' in result))
      throw new Error('Expected conversation summaries');
    return result;
  },
  turn: (
    threadId: string,
    turnId: string,
    cursor?: string,
    signal?: AbortSignal,
  ) =>
    api.threads.turn(
      { params: { threadId, turnId }, query: { cursor } },
      { signal },
    ),
  stopSpeech: (threadId: string) =>
    api.threads.stopSpeech({ params: { threadId } }),
  abort: (threadId: string) => api.threads.abort({ params: { threadId } }),
  compact: (threadId: string) => api.threads.compact({ params: { threadId } }),
  clearGoal: (threadId: string) =>
    api.threads.clearGoal({ params: { threadId } }),
  cancelBackgroundTask: (threadId: string, taskId: string) =>
    api.threads.cancelBackgroundTask({ params: { threadId, taskId } }),
  cleanupCommandSession: (threadId: string, sessionId: number) =>
    api.threads.cleanupCommandSession({ params: { threadId, sessionId } }),
  respondToTool: (
    threadId: string,
    interactionId: string,
    response: ToolResponse,
  ) =>
    api.threads.respondToTool({
      params: { threadId, interactionId },
      body: response,
    }),
  retry: (threadId: string) => api.threads.retry({ params: { threadId } }),
  continue: (threadId: string) =>
    api.threads.continue({ params: { threadId } }),
  queued: (threadId: string, messageId: string, signal?: AbortSignal) =>
    api.threads.queued({ params: { threadId, messageId } }, { signal }),
  updateQueued: (
    threadId: string,
    messageId: string,
    body: UpdateQueuedMessage,
  ) => api.threads.updateQueued({ params: { threadId, messageId }, body }),
  moveQueued: (threadId: string, messageId: string, beforeId: string | null) =>
    api.threads.moveQueued({
      params: { threadId },
      body: { id: messageId, beforeId },
    }),
  cancel: (threadId: string, messageId: string) =>
    api.threads.cancelQueued({ params: { threadId, messageId } }),
  clearQueue: (threadId: string) =>
    api.threads.clearQueue({ params: { threadId } }),
  preferences: () => api.threads.preferences(),
  projectPreferences: (projectId: string) =>
    api.projects.preferences({ params: { projectId } }),
  savePreferences: (settings: ChatSettings) =>
    api.threads.savePreferences({ body: settings }),
};

export function chatErrorKey(error: unknown) {
  const code = apiErrorCode(error)
    ? apiErrorCode(error)
    : typeof error === 'string'
      ? error
      : '';
  switch (code) {
    case 'AGENT_NOT_FOUND':
      return 'agents.selectionUnavailable';
    case 'AGENT_NOT_PUBLISHED':
      return 'agents.notPublished';
    case 'AGENT_CHANGE_BUSY':
      return 'chat.agentBusy';
    case 'AGENT_SKILL_UNAVAILABLE':
      return 'agents.skillUnavailable';
    case 'AGENT_MODEL_UNAVAILABLE':
      return 'agents.modelUnavailable';
    case 'UNAUTHORIZED':
      return 'errors.sessionExpired';
    case 'FORBIDDEN':
      return 'errors.forbidden';
    case 'THREAD_NOT_FOUND':
      return 'chat.errors.notFound';
    case 'THREAD_NOT_ARCHIVED':
      return 'personalSettings.notArchived';
    case 'WORKSPACE_UNAVAILABLE':
      return 'personalSettings.workspaceUnavailable';
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
    case 'PROJECT_GIT_UNAVAILABLE':
      return 'projects.github.gitUnavailable';
    case 'PROJECT_CLONE_TIMEOUT':
      return 'projects.github.timeout';
    case 'PROJECT_CLONE_FAILED':
      return 'projects.github.failed';
    case 'MODEL_NOT_CONFIGURED':
      return 'chat.errors.noModel';
    case 'MODEL_UNAVAILABLE':
      return 'chat.errors.modelUnavailable';
    case 'MODEL_NO_IMAGES':
      return 'chat.errors.noImages';
    case 'RUN_INTERRUPTED':
      return 'chat.errors.interrupted';
    case 'RETRY_UNAVAILABLE':
      return 'chat.errors.retryUnavailable';
    case 'CONTINUE_UNAVAILABLE':
      return 'chat.errors.continueUnavailable';
    case 'THREAD_BUSY':
      return 'chat.errors.busy';
    case 'COMPACTION_BUSY':
      return 'chat.compression.busy';
    case 'TOOL_NOT_PENDING':
      return 'chat.errors.toolNotPending';
    case 'BACKGROUND_TASK_NOT_FOUND':
      return 'chat.backgroundTaskNotFound';
    case 'BACKGROUND_TASKS_UNAVAILABLE':
      return 'chat.backgroundTaskStopFailed';
    case 'QUEUED_MESSAGE_NOT_FOUND':
      return 'chat.errors.queuedGone';
    case 'QUEUE_UPDATE_FAILED':
      return 'chat.errors.queueUpdateFailed';
    case 'TOOL_RESPONSE_REQUIRED':
      return 'chat.toolInteraction.waiting';
    case 'VALIDATION_ERROR':
      return 'chat.errors.validation';
    default:
      return error instanceof TypeError
        ? 'errors.network'
        : 'chat.errors.failed';
  }
}
