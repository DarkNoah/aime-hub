import { rpc, required } from '../../rpc/context.js';
import type { ToolService } from './service.js';

export function toolRouter(service?: ToolService) {
  const p = rpc.tools;
  return p.router({
    list: p.list.handler(() => required(service).list()),
    update: p.update.handler(({ input }) =>
      required(service).update(input.params.toolId, input.body),
    ),
  });
}
