import { z } from 'zod';
import { isToolUIPart } from 'ai';
import type { ChatTurnSummary } from '@aime/shared/chat-turns';
import { isDeepStrictEqual } from 'node:util';
import {
  userQuestionSchema,
  type AskUserAnswer,
  type ToolInteraction,
  type ToolResponse,
} from '@aime/shared/threads';
import { ThreadError } from './errors.js';
import { MCP_AUTHORIZATION_TOOL } from '@aime/shared/mcp';
import {
  INTELLIGENT_UI_TOOL,
  parseIntelligentUiResponse,
} from '@aime/shared/intelligent-ui';

export type QuestionBatch = {
  userId: string;
  turnId: string;
  runId: string;
  answers: AskUserAnswer[];
};

export function queuedQuestionAnswer(
  batch: QuestionBatch | null,
  item: ToolInteraction,
) {
  if (
    !batch ||
    item.kind !== 'suspended' ||
    item.toolName !== 'ask_user' ||
    item.runId !== batch.runId ||
    item.turnId !== batch.turnId
  )
    return;
  return batch.answers.find((answer) => answer.toolCallId === item.toolCallId);
}

export function questionResponses(
  turnId: string,
  interactions: readonly ToolInteraction[],
  batch?: QuestionBatch | null,
) {
  const responses = new Map<string, ToolResponse>();
  if (batch?.turnId === turnId)
    for (const item of batch.answers)
      responses.set(item.toolCallId, item.response);
  for (const item of interactions) {
    if (item.turnId !== turnId || item.toolName !== 'ask_user') continue;
    if (item.kind === 'suspended' && item.response)
      responses.set(item.toolCallId, item.response);
    else if (item.kind === 'approval' && !item.response)
      responses.delete(item.toolCallId);
  }
  return responses;
}

/** An acknowledgement can be retried while the remaining calls are still queued. */
export function alreadyReceivedAnswers(
  anchor: ToolInteraction,
  answers: AskUserAnswer[],
  interactions: readonly ToolInteraction[],
  batch: QuestionBatch | null,
) {
  const responses = new Map(
    interactions
      .filter(
        (item) =>
          item.runId === anchor.runId &&
          item.kind === 'suspended' &&
          item.toolName === 'ask_user',
      )
      .map((item) => [item.toolCallId, item.response]),
  );
  if (batch?.runId === anchor.runId)
    for (const item of batch.answers)
      responses.set(item.toolCallId, item.response);
  return answers.every((item) =>
    isDeepStrictEqual(item.response, responses.get(item.toolCallId)),
  );
}

/** Check the whole form before resuming even the first native suspension. */
export function validateQuestionAnswers(
  turn: ChatTurnSummary,
  anchor: ToolInteraction,
  answers: AskUserAnswer[],
) {
  const group = turn.askUserGroups?.find((ids) =>
    ids.includes(anchor.toolCallId),
  );
  const byCall = new Map(
    answers.map((item) => [item.toolCallId, item.response]),
  );
  const tools = turn.assistant?.parts.filter(isToolUIPart) ?? [];
  const open = tools.filter(
    (tool) =>
      group?.includes(tool.toolCallId) && !tool.state.startsWith('output-'),
  );
  if (
    !byCall.has(anchor.toolCallId) ||
    byCall.size !== answers.length ||
    open.length !== answers.length ||
    new Set(answers.map((item) => item.response.id)).size !== answers.length
  )
    throw new ThreadError('VALIDATION_ERROR', 400);
  for (const tool of open) {
    const response = byCall.get(tool.toolCallId);
    if (
      !response ||
      tool.state === 'input-streaming' ||
      tool.state === 'approval-requested' ||
      !userQuestionSchema.safeParse(tool.input).success
    )
      throw new ThreadError('VALIDATION_ERROR', 400);
    validateToolResponse(
      tool.toolCallId === anchor.toolCallId
        ? anchor
        : {
            ...anchor,
            toolCallId: tool.toolCallId,
            suspendPayload: tool.input,
            resumeSchema: undefined,
          },
      response,
    );
  }
}

/** Validate before consuming a suspension so a malformed response remains retryable. */
export function validateToolResponse(
  interaction: ToolInteraction,
  response: ToolResponse,
  userId?: string,
) {
  if (interaction.toolName === MCP_AUTHORIZATION_TOOL) {
    const payload = z
      .object({ userId: z.string() })
      .safeParse(interaction.suspendPayload);
    if (!userId || !payload.success || payload.data.userId !== userId)
      throw new ThreadError('FORBIDDEN', 403);
  }
  if (interaction.toolName === 'ask_user' && response.action === 'decline')
    return;
  if ((interaction.kind === 'suspended') !== (response.action === 'resume'))
    throw new ThreadError('VALIDATION_ERROR', 400);
  if (response.action !== 'resume') return;
  if (interaction.toolName === INTELLIGENT_UI_TOOL) {
    try {
      parseIntelligentUiResponse(response.data);
    } catch {
      throw new ThreadError('VALIDATION_ERROR', 400);
    }
  }
  if (interaction.resumeSchema !== undefined) {
    try {
      const schema =
        typeof interaction.resumeSchema === 'string'
          ? JSON.parse(interaction.resumeSchema)
          : interaction.resumeSchema;
      if (
        typeof schema !== 'boolean' &&
        (!schema || typeof schema !== 'object' || Array.isArray(schema))
      )
        throw new Error('Invalid resume schema');
      z.fromJSONSchema(schema).parse(response.data);
    } catch {
      throw new ThreadError('VALIDATION_ERROR', 400);
    }
  }
  if (interaction.toolName === 'ask_user') {
    const question = userQuestionSchema.parse(interaction.suspendPayload);
    const values = Array.isArray(response.data)
      ? response.data
      : [response.data];
    if (
      (question.selectionMode === 'multi_select') !==
        Array.isArray(response.data) ||
      !values.length ||
      values.some((value) => typeof value !== 'string' || !value.trim())
    )
      throw new ThreadError('VALIDATION_ERROR', 400);
  }
}
