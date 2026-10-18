import type { Memory } from '@mastra/memory';
import {
  isUserAuthoredMessage,
  type MastraDBMessage,
} from '@mastra/core/agent';
import { mergeThreadMessages } from '@aime/shared/thread-messages';
import { z } from 'zod';
import { threadMessages } from './message-conversion.js';
import { groupTurns } from './turns.js';
import { ThreadError } from './errors.js';

export const TURN_PAGE_SIZE = 20;
const STORAGE_PAGE_SIZE = 100;
type Scope = { threadId: string; resourceId?: string };
type TurnMemory = Pick<Memory, 'recall'>;
const boundarySchema = z.object({
  threadId: z.string(),
  id: z.string(),
  at: z.iso.datetime(),
});

function boundary(scope: Scope, message: MastraDBMessage) {
  return Buffer.from(
    JSON.stringify({
      threadId: scope.threadId,
      id: message.id,
      at: new Date(message.createdAt).toISOString(),
    }),
  ).toString('base64url');
}

function parseBoundary(scope: Scope, cursor: string) {
  try {
    const value = boundarySchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString()),
    );
    if (value.threadId !== scope.threadId) throw new Error('Wrong thread');
    return value;
  } catch {
    throw new ThreadError('VALIDATION_ERROR', 400);
  }
}

/** Read storage pages until a whole number of user turns is available. */
export async function readTurnPage(
  memory: TurnMemory,
  scope: Scope,
  cursor?: string,
) {
  const before = cursor ? parseBoundary(scope, cursor) : undefined;
  const end = before ? new Date(before.at) : new Date();
  let foundBoundary = !before;
  const selected: MastraDBMessage[] = [];
  const locators = new Map<string, string>();
  let users = 0;
  for (let page = 0; ; page++) {
    const result = await memory.recall({
      ...scope,
      page,
      perPage: STORAGE_PAGE_SIZE,
      includeTotal: false,
      hideSignals: false,
      filter: { dateRange: { end } },
      orderBy: { field: 'createdAt', direction: 'DESC' },
    });
    // Recall selects the requested storage page but MessageList returns it in
    // chronological order. Preserve the store's tie ordering while reversing time.
    const rows = [...result.messages].sort(
      (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
    );
    for (const [index, message] of rows.entries()) {
      if (!foundBoundary) {
        if (message.id === before!.id) foundBoundary = true;
        continue;
      }
      selected.push(message);
      if (!isUserAuthoredMessage(message)) continue;
      const user = threadMessages([message]).find(
        (item) => item.role === 'user',
      );
      if (!user) continue;
      locators.set(user.id, boundary(scope, message));
      if (++users === TURN_PAGE_SIZE) {
        const hasMore = index < rows.length - 1 || result.hasMore;
        return {
          messages: mergeThreadMessages([], threadMessages(selected.reverse())),
          locators,
          cursor: hasMore ? boundary(scope, message) : null,
          hasMore,
        };
      }
    }
    if (!result.hasMore) break;
  }
  if (!foundBoundary) throw new ThreadError('HISTORY_CURSOR_EXPIRED', 409);
  const messages = mergeThreadMessages([], threadMessages(selected.reverse()));
  // Automation/legacy threads can begin with an assistant without a user signal.
  const first = groupTurns(messages)[0];
  if (first && !locators.has(first.id)) {
    const start = selected.find((message) => message.id === first.id);
    if (start) locators.set(first.id, boundary(scope, start));
  }
  return { messages, locators, cursor: null, hasMore: false };
}

/** A locator is only a query hint: verify its thread and logical turn ID. */
export async function readTurnDetail(
  memory: TurnMemory,
  scope: Scope,
  id: string,
  cursor: string,
) {
  const start = parseBoundary(scope, cursor);
  let found = false;
  const selected: MastraDBMessage[] = [];
  for (let page = 0; ; page++) {
    const result = await memory.recall({
      ...scope,
      page,
      perPage: STORAGE_PAGE_SIZE,
      includeTotal: false,
      hideSignals: false,
      filter: { dateRange: { start: new Date(start.at) } },
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    for (const message of result.messages) {
      if (!found) {
        if (message.id !== start.id) continue;
        const converted = threadMessages([message])[0];
        if (!converted || converted.id !== id)
          throw new ThreadError('TURN_NOT_FOUND', 404);
        found = true;
      } else if (isUserAuthoredMessage(message)) {
        return mergeThreadMessages([], threadMessages(selected));
      }
      selected.push(message);
    }
    if (!result.hasMore) break;
  }
  if (!found) throw new ThreadError('TURN_NOT_FOUND', 404);
  return mergeThreadMessages([], threadMessages(selected));
}
