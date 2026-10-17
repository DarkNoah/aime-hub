import { rpc, required } from '../../rpc/context.js';
import type { SystemSettingsService } from './service.js';
import { E2BDesktopService } from '../e2b-desktop/service.js';

export function systemSettingsRouter(service?: SystemSettingsService) {
  const p = rpc.systemSettings;
  const desktop = service ? new E2BDesktopService(service) : undefined;
  return p.router({
    desktop: p.desktop.router({
      test: p.desktop.test.handler(() => required(desktop).test()),
      list: p.desktop.list.handler(({ input }) =>
        required(desktop).list(input.query?.nextToken),
      ),
      create: p.desktop.create.handler(({ input }) =>
        required(desktop).create(input.body),
      ),
      get: p.desktop.get.handler(({ input }) =>
        required(desktop).get(input.params.id),
      ),
      update: p.desktop.update.handler(({ input }) =>
        required(desktop).update(input.params.id, input.body.timeoutSeconds),
      ),
      delete: p.desktop.delete.handler(({ input }) =>
        required(desktop).delete(input.params.id),
      ),
    }),
    get: p.get.handler(() => required(service).get()),
    update: p.update.handler(({ input }) =>
      required(service).update(input.body),
    ),
  });
}
