import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import type { ToolInteraction, ToolResponse } from '@aime/shared/threads';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function getSubmitPlanData(
  interaction?: ToolInteraction,
  tool?: ToolUIPart | DynamicToolUIPart,
  response = interaction?.response,
) {
  const output = record(tool?.output);
  const resumed = record(
    response?.action === 'resume' ? response.data : undefined,
  );
  const submitted = record(output.submittedPlan);
  const sources = [
    resumed,
    submitted,
    record(interaction?.suspendPayload),
    record(interaction?.input),
    record(tool?.input),
  ];
  const field = (name: string) => {
    for (const source of sources) {
      const value = source[name];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return undefined;
  };
  const action = resumed.action ?? submitted.action;
  const decision =
    response?.action === 'decline' || tool?.state === 'output-denied'
      ? 'rejected'
      : action === 'approved' || action === 'rejected'
        ? action
        : undefined;
  return {
    path: field('path'),
    title: field('title'),
    decision,
    feedback: field('feedback'),
    failed: tool?.state === 'output-error' || output.isError === true,
  };
}

/** submit_plan uses resume data, not the pre-execution approval protocol. */
export function createSubmitPlanResponse(
  action: 'approved' | 'rejected',
  path?: string,
  feedback?: string,
): Omit<Extract<ToolResponse, { action: 'resume' }>, 'id'> {
  return {
    action: 'resume',
    data: {
      action,
      ...(path ? { path } : {}),
      ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
    },
  };
}
