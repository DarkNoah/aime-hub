import type { ToolUIPart } from 'ai';

export const toolStatusLabels = {
  'approval-requested': 'chat.toolAwaitingApproval',
  'approval-responded': 'chat.toolApprovalResponded',
  'input-available': 'chat.toolRunning',
  'input-streaming': 'chat.toolPending',
  'output-available': 'chat.toolDone',
  'output-denied': 'chat.toolDenied',
  'output-error': 'chat.toolFailed',
} as const satisfies Record<ToolUIPart['state'], string>;
