import { rpc, required } from '../../rpc/context.js';
import type { SystemSettingsService } from './service.js';

export function systemSettingsRouter(service?: SystemSettingsService) {
  const p = rpc.systemSettings;
  return p.router({
    get: p.get.handler(() => required(service).get()),
    update: p.update.handler(({ input }) =>
      required(service).update(input.body),
    ),
  });
}
