import type { DynamicToolUIPart, FileUIPart, ToolUIPart } from 'ai';
import { readFileBlocks } from './message-preview/read-file-output.js';
import { browserScreenshotOutput } from './message-preview/browser-data.js';
import { getToolName } from './tool-renderers/registry.js';

export type ToolAttachment = FileUIPart & {
  id: string;
  workspacePath?: string;
};

export function getToolAttachments(
  tools: (ToolUIPart | DynamicToolUIPart)[],
): ToolAttachment[] {
  return tools.flatMap((tool) => {
    if (tool.state !== 'output-available') return [];
    let output = tool.output;
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output) as unknown;
      } catch {
        return [];
      }
    }
    const record =
      output && typeof output === 'object'
        ? (output as Record<string, unknown>)
        : undefined;
    if (getToolName(tool) === 'browser_screenshot')
      output = browserScreenshotOutput(output);
    const input =
      tool.input && typeof tool.input === 'object'
        ? (tool.input as Record<string, unknown>)
        : undefined;
    const path =
      typeof record?.file_path === 'string'
        ? record.file_path
        : typeof input?.path === 'string'
          ? input.path
          : undefined;

    return readFileBlocks(output, path).flatMap((block, index) =>
      block.type === 'media' && block.source
        ? [
            {
              id: `${tool.toolCallId}:${index}`,
              type: 'file' as const,
              url: block.source,
              mediaType: block.mediaType,
              filename: block.filename?.split('/').at(-1) || undefined,
              workspacePath: path,
            },
          ]
        : [],
    );
  });
}
