import { nanoid } from 'nanoid';
import type { UIMessage } from 'ai';
import {
  type ChatSettings,
  type ToolInteraction,
  toolInteractionSchema,
} from '@aime/shared/threads';
import type { QuestionBatch } from './tool-interactions.js';
import { groupTurns } from './turns.js';

type StoredInteraction = ToolInteraction & { settings: ChatSettings };

/** Native memory and thread metadata checkpoint a suspension in separate writes. */
export function recoverQuestionInteractions(
  batch: QuestionBatch,
  interactions: readonly StoredInteraction[],
  messages: readonly UIMessage[],
) {
  const turn = groupTurns(messages).at(-1);
  if (turn?.id !== batch.turnId) return;
  const sameRun = (item: StoredInteraction) =>
    item.runId === batch.runId && item.turnId === batch.turnId;
  const anchor = interactions.find(
    (item) =>
      sameRun(item) &&
      item.toolName === 'ask_user' &&
      item.kind === 'suspended' &&
      item.response,
  );
  if (!anchor) return;
  const pending = new Map<string, StoredInteraction>();
  for (const message of turn.messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (
        part.type !== 'data-tool-call-suspended' &&
        part.type !== 'data-tool-call-approval'
      )
        continue;
      const marker = part.data;
      if (
        !marker ||
        typeof marker !== 'object' ||
        !('runId' in marker) ||
        marker.runId !== batch.runId ||
        ('resumed' in marker && marker.resumed) ||
        ('taskId' in marker && marker.taskId)
      )
        continue;
      const parsed = toolInteractionSchema.safeParse({
        ...marker,
        kind:
          part.type === 'data-tool-call-approval' ? 'approval' : 'suspended',
        input: 'args' in marker ? marker.args : undefined,
      }).data;
      if (!parsed) continue;
      const stored = interactions.find(
        (item) =>
          sameRun(item) &&
          item.toolCallId === parsed.toolCallId &&
          item.kind === parsed.kind &&
          item.toolName === parsed.toolName,
      );
      if (!stored?.response)
        pending.set(parsed.toolCallId, {
          ...parsed,
          id: stored?.id ?? nanoid(),
          turnId: batch.turnId,
          settings: stored?.settings ?? anchor.settings,
        });
    }
  }
  if (!pending.size) return;
  return [
    ...interactions.filter((item) => !sameRun(item) || item.response),
    ...pending.values(),
  ];
}
