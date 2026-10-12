import { rpc, required } from '../../rpc/context.js';
import type { NotificationService } from './service.js';
export function notificationRouter(service?: NotificationService) {
  const p = rpc.notifications;
  return p.router({
    config: p.config.handler(() => required(service).config()),
    subscribe: p.subscribe.handler(({ context, input }) =>
      required(service).register(context.userId, context.session.id, input),
    ),
    unsubscribe: p.unsubscribe.handler(({ context, input }) =>
      required(service).unregister(context.userId, input.endpoint),
    ),
  });
}
