import type { ThreadService } from '../../apps/server/src/modules/threads/service.js';
type Memory = ConstructorParameters<typeof ThreadService>[0];
type Thread = NonNullable<Awaited<ReturnType<Memory['getThreadById']>>>;
type StoredMessage = Parameters<Memory['saveMessages']>[0]['messages'][number];

export function fakeMemory() {
  const threads = new Map<string, Thread>();
  const messages = new Map<string, StoredMessage>();
  const memory: Memory = {
    async createThread({ threadId, resourceId, title, metadata }) {
      const thread = {
        id: threadId!,
        resourceId,
        title,
        metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      threads.set(thread.id, structuredClone(thread));
      return structuredClone(thread);
    },
    async getThreadById({ threadId }) {
      return structuredClone(threads.get(threadId) ?? null);
    },
    async updateThread({ id, title, metadata }) {
      const thread = {
        ...threads.get(id)!,
        title,
        metadata: { ...threads.get(id)!.metadata, ...metadata },
        updatedAt: new Date(),
      };
      threads.set(id, structuredClone(thread));
      return structuredClone(thread);
    },
    async listThreads({ filter, page = 0, perPage = 30 }) {
      const all = [...threads.values()].filter(
        (thread) => thread.resourceId === filter?.resourceId,
      );
      const size = perPage || all.length;
      return {
        threads: all.slice(page * size, (page + 1) * size),
        page,
        perPage,
        total: all.length,
        hasMore: (page + 1) * size < all.length,
      };
    },
    async recall({ threadId, page = 0, perPage = 40, filter }) {
      const all = [...messages.values()]
        .filter(
          (message) =>
            message.threadId === threadId &&
            (!filter?.dateRange?.end ||
              message.createdAt <= filter.dateRange.end),
        )
        .sort((a, b) => +b.createdAt - +a.createdAt);
      const size = perPage || all.length;
      return {
        messages: all.slice(page * size, (page + 1) * size),
        page,
        perPage,
        total: all.length,
        hasMore: (page + 1) * size < all.length,
      };
    },
    async saveMessages({ messages: input }) {
      input.forEach((message) => messages.set(message.id, message));
      return { messages: input };
    },
    async deleteThread(id) {
      threads.delete(id);
      for (const [key, message] of messages)
        if (message.threadId === id) messages.delete(key);
    },
  };
  return { memory, threads, messages };
}
