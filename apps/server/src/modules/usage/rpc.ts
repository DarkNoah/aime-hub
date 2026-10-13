import { rpc, required } from '../../rpc/context.js';
import type { UsageService } from './service.js';

export function usageRouter(service?: UsageService) {
  const p = rpc.usage;
  return p.router({
    summary: p.summary.handler(({ input }) =>
      required(service).summary(input.query),
    ),
    records: p.records.handler(({ input }) =>
      required(service).records(input.query),
    ),
  });
}
