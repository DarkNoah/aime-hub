import { convertMessages } from '@mastra/core/agent';
import type { MastraCompositeStore, MemoryStorage } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import type { UIMessage } from 'ai';

type SaveMessages = MemoryStorage['saveMessages'];

// Observe every native persistence path, including OM step/abort cleanup that
// bypasses processOutputResult. Proxies belong to this session; the shared store is
// never patched, and methods retain their original receiver/private fields.
function observeMessageWrites(
  storage: MastraCompositeStore,
  save: (
    store: MemoryStorage,
    args: Parameters<SaveMessages>[0],
  ) => ReturnType<SaveMessages>,
) {
  const memoryStores = new WeakMap<MemoryStorage, MemoryStorage>();
  return new Proxy(storage, {
    get(target, key) {
      if (key === 'getStore') {
        return async (
          name: Parameters<MastraCompositeStore['getStore']>[0],
        ) => {
          const store = await target.getStore(name);
          if (name !== 'memory' || !store) return store;
          const memory = store as MemoryStorage;
          let observed = memoryStores.get(memory);
          if (!observed) {
            observed = new Proxy(memory, {
              get(target, key) {
                if (key === 'saveMessages')
                  return (args: Parameters<SaveMessages>[0]) =>
                    save(target, args);
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
            memoryStores.set(memory, observed);
          }
          return observed;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Observe native saves, including late tool results after a stream was aborted. */
export class ThreadMessageMemory extends Memory {
  private readonly writes: { pending: Promise<unknown> };

  constructor(
    options: NonNullable<ConstructorParameters<typeof Memory>[0]> & {
      storage: MastraCompositeStore;
    },
    scope: { threadId: string; resourceId?: string },
    onPersistedMessage: (message: UIMessage) => void,
  ) {
    const writes = { pending: Promise.resolve() as Promise<unknown> };
    super({
      ...options,
      storage: observeMessageWrites(options.storage, (store, args) => {
        const saving = writes.pending.then(async () => {
          const result = await store.saveMessages(args);
          const messages = result.messages.filter(
            (message) =>
              message.role === 'assistant' &&
              message.threadId === scope.threadId &&
              message.resourceId === scope.resourceId,
          );
          for (const message of convertMessages(messages).to(
            'AIV6.UI',
          ) as UIMessage[])
            onPersistedMessage(message);
          return result;
        });
        writes.pending = saving.catch(() => {});
        return saving;
      }),
    });
    this.writes = writes;
  }

  override async settled() {
    await super.settled();
    await this.writes.pending;
  }
}
