import { rpc, required } from '../../rpc/context.js';
import type { SkillService } from './service.js';

export function skillRouter(service?: SkillService) {
  const p = rpc.skills;
  const skills = () => required(service);
  return p.router({
    list: p.list.handler(() => skills().list()),
    scan: p.scan.handler(({ input, signal }) =>
      skills().scan(input.body.url, signal),
    ),
    discard: p.discard.handler(({ input }) =>
      skills().discard(input.params.id),
    ),
    install: p.install.handler(({ input }) =>
      skills().install(input.body.scanId, input.body.paths),
    ),
    remove: p.remove.handler(({ input }) => skills().remove(input.body.path)),
    removeGroup: p.removeGroup.handler(({ input }) =>
      skills().removeGroup(input.body.group, input.body.paths),
    ),
  });
}
