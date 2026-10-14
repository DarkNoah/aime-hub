import { fileURLToPath } from 'node:url';
import { syncBuiltinSkills } from '../skills/builtin.js';

export function syncPluginSkills(workspaceRoot: string) {
  // During development this sits beside the source module; tsup copies it beside dist/index.js.
  return syncBuiltinSkills(
    fileURLToPath(new URL('./bundled-skills/', import.meta.url)),
    workspaceRoot,
    'plugins',
  );
}
