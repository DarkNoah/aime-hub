import type { DynamicToolUIPart, ToolUIPart } from 'ai';

// Keep this registry free of React imports so message grouping can use it too.
export const specialToolNames = ['ask_user', 'submit_plan'] as const;
export type SpecialToolName = (typeof specialToolNames)[number];

export function getToolName(tool?: ToolUIPart | DynamicToolUIPart) {
  return tool?.type === 'dynamic-tool' ? tool.toolName : tool?.type.slice(5);
}

export function isSpecialTool(
  name: string | undefined,
): name is SpecialToolName {
  return specialToolNames.some((toolName) => toolName === name);
}
