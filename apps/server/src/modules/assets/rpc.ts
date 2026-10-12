import { rpc, required } from '../../rpc/context.js';
import type { ThreadService } from '../threads/service.js';
import type { AssetService } from './service.js';
import { fileError } from '../files/paths.js';

export function assetRouter(service?: AssetService, threads?: ThreadService) {
  const p = rpc.assets.use(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      fileError(error);
    }
  });
  return p.router({
    list: p.list.handler(({ context, input }) =>
      required(service).list(
        required(threads),
        context.userId,
        input.params.threadId,
        input.query,
      ),
    ),
    attach: p.attach.handler(({ context, input, signal }) =>
      required(service).attach(
        required(threads),
        context.userId,
        input.params.threadId,
        input.body.ids,
        signal,
      ),
    ),
  });
}
