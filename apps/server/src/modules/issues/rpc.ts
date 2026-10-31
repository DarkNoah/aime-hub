import { rpc, required } from '../../rpc/context.js';
import type { IssueService } from './service.js';

export function issueRouter(service?: IssueService) {
  const p = rpc.issues;
  const issues = () => required(service);
  return p.router({
    forThread: p.forThread.handler(({ context, input }) =>
      issues().forThread(context.userId, input.threadId, input),
    ),
    list: p.list.handler(({ context, input }) =>
      issues().list(context.userId, input),
    ),
    view: p.view.handler(({ context, input }) =>
      issues().view(context.userId, input.id, input, input.cursor),
    ),
    create: p.create.handler(({ context, input }) =>
      issues().create(context.userId, input, input.data),
    ),
    edit: p.edit.handler(({ context, input }) =>
      issues().edit(context.userId, input.id, input, input.data),
    ),
    close: p.close.handler(({ context, input }) =>
      issues().edit(context.userId, input.id, input, { state: 'done' }),
    ),
    reopen: p.reopen.handler(({ context, input }) =>
      issues().edit(context.userId, input.id, input, { state: 'todo' }),
    ),
    stop: p.stop.handler(({ context, input }) =>
      issues().stop(context.userId, input.id, input),
    ),
    comment: p.comment.handler(({ context, input }) =>
      issues().comment(context.userId, input.id, input, input.data.body),
    ),
    message: p.message.handler(({ context, input }) =>
      issues().message(
        context.userId,
        input.id,
        input,
        input.data.body,
        input.data.delivery,
      ),
    ),
  });
}
