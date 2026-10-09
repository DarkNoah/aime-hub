import { rpc, required } from '../../rpc/context.js';
import type { RequestLogService } from './service.js';

export function requestLogRouter(service?: RequestLogService) {
  const p = rpc.requestLogs;
  return p.router({
    list: p.list.handler(({ input }) => required(service).list(input.query)),
    get: p.get.handler(({ input }) => required(service).get(input.params.id)),
  });
}
