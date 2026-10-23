import type { ToolConfig } from '@aime/shared/tools';
import { ConfiguredTool } from '@app/plugin-sdk/tools';
import type { ToolDependencies } from './types.js';

export {
  BaseTool,
  agentAllowed,
  toolArray,
  loadToolSettings,
} from '@app/plugin-sdk/tools';
export type { ToolSettings } from '@app/plugin-sdk/tools';

/** Host tools can additionally resolve application services and model providers. */
export abstract class BuiltinTool<
  K extends ToolConfig['kind'] = 'builtin',
> extends ConfiguredTool<K, ToolDependencies> {}
