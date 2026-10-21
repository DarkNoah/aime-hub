import { rpc, required } from '../../rpc/context.js';
import type { GroupChatService } from './service.js';

export function groupChatRouter(service?: GroupChatService) {
  const p = rpc.groupChats;
  const rooms = () => required(service);
  return p.router({
    openDefault: p.openDefault.handler(({ context, input }) =>
      rooms().openDefault(context.userId, input.body.projectId),
    ),
    list: p.list.handler(({ context, input }) =>
      rooms().list(context.userId, input.query),
    ),
    create: p.create.handler(({ context, input }) =>
      rooms().create(context.userId, input.body),
    ),
    get: p.get.handler(({ context, input }) =>
      rooms().get(context.userId, input.params.roomId),
    ),
    update: p.update.handler(({ context, input }) =>
      rooms().update(context.userId, input.params.roomId, input.body.title),
    ),
    remove: p.remove.handler(({ context, input }) =>
      rooms().remove(context.userId, input.params.roomId),
    ),
    messages: p.messages.handler(({ context, input }) =>
      rooms().messages(context.userId, input.params.roomId, input.query),
    ),
    send: p.send.handler(({ context, input }) =>
      rooms().send(context.userId, input.params.roomId, input.body),
    ),
  });
}
