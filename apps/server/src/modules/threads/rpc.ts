import { rpc, required } from '../../rpc/context.js';
import type { ThreadService } from './service.js';
import type { LanguageModelService } from '../models/language-model.js';

export function threadRouter(
  service?: ThreadService,
  models?: LanguageModelService,
) {
  const p = rpc.threads;
  const threads = () => required(service);
  return p.router({
    archived: p.archived.handler(({ context }) =>
      threads().listArchivedThreads(context.userId),
    ),
    restore: p.restore.handler(({ context, input }) =>
      threads().restoreThread(context.userId, input.params.threadId),
    ),
    removeArchived: p.removeArchived.handler(({ context, input }) =>
      threads().deleteArchivedThread(context.userId, input.params.threadId),
    ),
    list: p.list.handler(({ context, input }) =>
      threads().listThreads(
        context.userId,
        input.query.page,
        input.query.projectId,
        input.query.perPage,
      ),
    ),
    create: p.create.handler(({ context, input }) =>
      threads().createThread(context.userId, input.body),
    ),
    get: p.get.handler(({ context, input }) =>
      threads().getThread(context.userId, input.params.threadId),
    ),
    update: p.update.handler(({ context, input }) =>
      threads().updateThread(context.userId, input.params.threadId, input.body),
    ),
    remove: p.remove.handler(({ context, input }) =>
      threads().deleteThread(context.userId, input.params.threadId),
    ),
    skills: p.skills.handler(({ context, input }) =>
      threads().listSkills(context.userId, input.query),
    ),
    preferences: p.preferences.handler(({ context }) =>
      required(models).getPreferences(context.userId),
    ),
    savePreferences: p.savePreferences.handler(({ context, input }) =>
      required(models).setPreferences(context.userId, input.body),
    ),
    history: p.history.handler(({ context, input }) =>
      threads().history(
        context.userId,
        input.params.threadId,
        input.query.page,
        input.query.anchor,
      ),
    ),
    run: p.run.handler(({ context, input }) =>
      threads().run(context.userId, input.params.threadId, {
        ...input.body,
        createdBy: context.userId,
        createdAt: new Date().toISOString(),
      }),
    ),
    abort: p.abort.handler(({ context, input }) =>
      threads().abort(context.userId, input.params.threadId),
    ),
    retry: p.retry.handler(({ context, input }) =>
      threads().retry(context.userId, input.params.threadId),
    ),
    continue: p.continue.handler(({ context, input }) =>
      threads().continueRun(context.userId, input.params.threadId),
    ),
    clearGoal: p.clearGoal.handler(({ context, input }) =>
      threads().clearGoal(context.userId, input.params.threadId),
    ),
    compact: p.compact.handler(({ context, input }) =>
      threads().compact(context.userId, input.params.threadId),
    ),
    cancelBackgroundTask: p.cancelBackgroundTask.handler(({ context, input }) =>
      threads().cancelBackgroundTask(
        context.userId,
        input.params.threadId,
        input.params.taskId,
      ),
    ),
    respondToTool: p.respondToTool.handler(({ context, input }) =>
      threads().respondToTool(
        context.userId,
        input.params.threadId,
        input.params.interactionId,
        input.body,
      ),
    ),
    queued: p.queued.handler(({ context, input }) =>
      threads().getQueued(
        context.userId,
        input.params.threadId,
        input.params.messageId,
      ),
    ),
    updateQueued: p.updateQueued.handler(({ context, input }) =>
      threads().updateQueued(
        context.userId,
        input.params.threadId,
        input.params.messageId,
        input.body,
      ),
    ),
    moveQueued: p.moveQueued.handler(({ context, input }) =>
      threads().moveQueued(
        context.userId,
        input.params.threadId,
        input.body.id,
        input.body.beforeId,
      ),
    ),
    cancelQueued: p.cancelQueued.handler(({ context, input }) =>
      threads().cancelQueued(
        context.userId,
        input.params.threadId,
        input.params.messageId,
      ),
    ),
    clearQueue: p.clearQueue.handler(({ context, input }) =>
      threads().clearQueue(context.userId, input.params.threadId),
    ),
  });
}
