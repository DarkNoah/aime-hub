import { rpc, required } from '../../rpc/context.js';
import type { GroupChatService } from './service.js';

export function groupChatRouter(service?: GroupChatService) {
  const p = rpc.groupChats;
  const rooms = () => required(service);
  return p.router({
    unread: p.unread.handler(({ context }) => rooms().unread(context.userId)),
    markRead: p.markRead.handler(({ context, input }) =>
      rooms().markRead(context.userId, input.params.roomId, input.body),
    ),
    removeA2aMember: p.removeA2aMember.handler(({ context, input }) =>
      rooms().removeA2aMember(
        context.userId,
        input.params.roomId,
        input.params.memberId,
      ),
    ),
    createA2aMember: p.createA2aMember.handler(({ context, input }) =>
      rooms().createA2aMember(context.userId, input.params.roomId, input.body),
    ),
    updateA2aMember: p.updateA2aMember.handler(({ context, input }) =>
      rooms().updateA2aMember(
        context.userId,
        input.params.roomId,
        input.params.memberId,
        input.body,
      ),
    ),
    revokeA2aMember: p.revokeA2aMember.handler(({ context, input }) =>
      rooms().revokeA2aMember(
        context.userId,
        input.params.roomId,
        input.params.memberId,
      ),
    ),
    searchUsers: p.searchUsers.handler(({ context, input }) =>
      rooms().searchUsers(
        context.userId,
        input.params.roomId,
        input.query.query,
      ),
    ),
    addMember: p.addMember.handler(({ context, input }) =>
      rooms().addMember(context.userId, input.params.roomId, input.body.userId),
    ),
    addAgent: p.addAgent.handler(({ context, input }) =>
      rooms().addAgent(context.userId, input.params.roomId, input.body),
    ),
    updateAgent: p.updateAgent.handler(({ context, input }) =>
      rooms().updateAgent(
        context.userId,
        input.params.roomId,
        input.params.agentId,
        input.body,
      ),
    ),
    removeAgent: p.removeAgent.handler(({ context, input }) =>
      rooms().removeAgent(
        context.userId,
        input.params.roomId,
        input.params.agentId,
      ),
    ),
    react: p.react.handler(({ context, input }) =>
      rooms().react(
        context.userId,
        input.params.roomId,
        input.params.messageId,
        input.body,
      ),
    ),
    respondUi: p.respondUi.handler(({ context, input }) =>
      rooms().respondUi(
        context.userId,
        input.params.roomId,
        input.params.messageId,
        input.body,
      ),
    ),
    search: p.search.handler(({ context, input }) =>
      rooms().search(context.userId, input.params.roomId, input.query),
    ),
    plans: p.plans.handler(({ context, input }) =>
      rooms().plans(context.userId, input.params.roomId),
    ),
    cancelPlan: p.cancelPlan.handler(({ context, input }) =>
      rooms().cancelPlan(
        context.userId,
        input.params.roomId,
        input.params.eventId,
      ),
    ),
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
