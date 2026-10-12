import type { ChatSession } from '../../apps/server/src/modules/threads/session.js';

/** A session boundary stub; real scheduling is covered by native-queue.test.ts. */
export function sessionStub(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    async send() {},
    async generateTitle() {
      return undefined;
    },
    async compact() {
      return { observed: false };
    },
    async clearGoal() {},
    async respond() {},
    async retry() {},
    abort() {},
    clearQueue() {},
    getQueued() {
      throw new Error('No pending input in this stub');
    },
    async updateQueued() {},
    async moveQueued() {},
    cancelQueued() {},
    async close() {},
    ...overrides,
  };
}

export async function openSessionStub() {
  return sessionStub();
}
