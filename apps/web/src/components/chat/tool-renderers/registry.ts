import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import { INTELLIGENT_UI_TOOL } from '@aime/shared/intelligent-ui';
import { MCP_AUTHORIZATION_TOOL } from '@aime/shared/mcp';

// Keep this registry free of React imports so message grouping can use it too.
export const specialToolNames = [
  MCP_AUTHORIZATION_TOOL,
  'issue',
  'ask_user',
  'submit_plan',
  INTELLIGENT_UI_TOOL,
] as const;
export type SpecialToolName = (typeof specialToolNames)[number];

export function getToolName(tool?: ToolUIPart | DynamicToolUIPart) {
  return tool?.type === 'dynamic-tool' ? tool.toolName : tool?.type.slice(5);
}

export function isSpecialTool(
  name: string | undefined,
): name is SpecialToolName {
  return specialToolNames.some((toolName) => toolName === name);
}
