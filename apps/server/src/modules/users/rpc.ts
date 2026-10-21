import { rpc, required } from '../../rpc/context.js';
import type { UserService } from './service.js';

export function userRouter(service?: UserService) {
  return rpc.users.router({
    lookup: rpc.users.lookup.handler(({ context, input }) =>
      required(service).lookup(
        context.userId,
        input.body.userIds,
        input.body.roomId,
      ),
    ),
  });
}
