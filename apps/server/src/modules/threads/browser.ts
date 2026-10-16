import {
  AgentBrowser,
  AgentBrowserThreadManager,
  BROWSER_TOOLS,
  closeInputSchema,
  tabsInputSchema,
} from '@mastra/agent-browser';
import {
  ScreencastStreamImpl,
  type MastraBrowser,
  type ScreencastOptions,
} from '@mastra/core/browser';
import { createTool } from '@mastra/core/tools';
import type { CDPSession } from 'playwright-core';
import { UserBrowser } from './browser/user-browser.js';

/** Project threads can contain messages from different users in the same Agent run. */
export class ThreadBrowserRouter extends AgentBrowser {
  constructor(
    private resolve: (userId: string) => MastraBrowser,
    private defaultUserId: string,
  ) {
    super({ scope: 'thread' });
  }

  override getTools() {
    const tools = this.resolve(this.defaultUserId).getTools();
    for (const [name, tool] of Object.entries(tools)) {
      tool.execute = (input, context) => {
        const author = context?.requestContext?.get('userId');
        const userId =
          typeof author === 'string' && author ? author : this.defaultUserId;
        return this.resolve(userId).getTools()[name]!.execute!(input, context);
      };
    }
    return tools;
  }
}

/** Mastra's thread routing is retained; the actual context belongs to the user. */
class ThreadBrowserManager extends AgentBrowserThreadManager {
  constructor(
    config: ConstructorParameters<typeof AgentBrowserThreadManager>[0],
    private owner: UserBrowser,
    private threadId: string,
  ) {
    super(config);
  }

  async open() {
    const manager = await this.owner.acquire(this.threadId);
    this.threadManagers.set(this.threadId, manager);
    this.sessions.set(this.threadId, {
      threadId: this.threadId,
      createdAt: Date.now(),
    });
    return manager;
  }
  override async getManagerForThread(threadId = this.threadId) {
    if (threadId !== this.threadId) throw new Error('Browser thread mismatch');
    const manager = this.owner.get(threadId);
    if (!manager?.isLaunched())
      throw new Error('Browser not running for this thread');
    return manager;
  }
  reset() {
    this.clearAllSessions();
    this.savedBrowserStates.clear();
  }
}

export class ThreadBrowser extends AgentBrowser {
  protected override threadManager: ThreadBrowserManager;
  private unsubscribe: () => void;
  private pending: Promise<unknown> = Promise.resolve();
  private opening?: Promise<void>;
  private released = false;

  constructor(
    private owner: UserBrowser,
    private threadId: string,
  ) {
    let manager!: ThreadBrowserManager;
    super({
      headless: true,
      // This scope routes tools and streams by thread. UserBrowser owns the shared process/profile.
      scope: 'thread',
      createThreadManager: (config) =>
        (manager = new ThreadBrowserManager(config, owner, threadId)),
    });
    this.threadManager = manager;
    this.setCurrentThread(threadId);
    this.unsubscribe = owner.onClosed(() => this.reset());
  }
  override setCurrentThread(threadId?: string) {
    if (threadId && this.threadId && threadId !== this.threadId)
      throw new Error('Browser thread mismatch');
    super.setCurrentThread(threadId ?? this.threadId);
  }
  override isBrowserRunning(threadId = this.threadId) {
    return (
      !this.released &&
      !this.owner.isClosing &&
      threadId === this.threadId &&
      !!this.owner.get(threadId)?.isLaunched()
    );
  }
  override hasThreadSession(threadId: string) {
    return this.isBrowserRunning(threadId);
  }
  override ensureReady() {
    if (this.released)
      return Promise.reject(new Error('Browser session released'));
    if (this.isBrowserRunning()) return Promise.resolve();
    this.opening ??= this.threadManager
      .open()
      .then(() => {
        if (!this.isBrowserRunning()) throw new Error('Browser closed');
        this.status = 'ready';
        this.notifyBrowserReady(this.threadId);
      })
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }
  override launch(threadId?: string) {
    this.setCurrentThread(threadId);
    return this.ensureReady();
  }
  override getManagerForThread(threadId = this.threadId) {
    return this.threadManager.getManagerForThread(threadId);
  }
  override closeThreadSession(threadId: string) {
    if (threadId !== this.threadId)
      return Promise.reject(new Error('Browser thread mismatch'));
    return this.owner.close();
  }
  override close() {
    return this.owner.close();
  }

  private async reset() {
    this.status = 'closed';
    this.lastBrowserState = undefined;
    this.threadManager.reset();
    await Promise.all(
      [...this.activeScreencastStreams.values()].map((stream) => stream.stop()),
    );
    this.activeScreencastStreams.clear();
    this.notifyBrowserClosed(this.threadId);
  }
  /** Chat/thread cleanup releases only its pages; explicit browser_close ends the user browser. */
  async release() {
    this.released = true;
    this.unsubscribe();
    await this.reset();
    await this.owner.release(this.threadId);
  }

  override getTools() {
    const tools = super.getTools();
    tools[BROWSER_TOOLS.CLOSE] = createTool({
      id: BROWSER_TOOLS.CLOSE,
      description:
        'End this user’s browser across all chat threads. Closes every tab, preserves login data, and does not restore old pages on the next launch. To close only a tab in this thread, use browser_tabs with action close.',
      inputSchema: closeInputSchema,
      execute: async () => {
        await this.close();
        return {
          success: true,
          hint: 'The user browser is closed for all threads. Login data is retained. Opening a URL starts fresh pages.',
        };
      },
    });
    tools[BROWSER_TOOLS.TABS] = createTool({
      id: BROWSER_TOOLS.TABS,
      description:
        'Manage only this chat thread’s browser tabs: list, new, switch or close. Indices are local to this thread. Listing a closed browser returns an empty list without starting it.',
      inputSchema: tabsInputSchema,
      execute: async (input) => {
        if (input.action !== 'new' && !this.isBrowserRunning()) {
          if (input.action !== 'list') throw new Error('Browser not running');
          return {
            success: true,
            tabs: [],
            hint: 'No browser is running. Open a URL or create a new tab to start a fresh browser session.',
          };
        }
        if (input.action === 'new' && !this.isBrowserRunning()) {
          await this.ensureReady();
          if (input.url) {
            const result = await this.goto({ url: input.url }, this.threadId);
            if (!result.success) return result;
          }
          return { success: true, index: 0, total: 1 };
        }
        return this.tabs(input, this.threadId);
      },
    });
    // Serialize tools within a thread. Other threads have independent pages and may run concurrently.
    for (const [name, tool] of Object.entries(tools)) {
      if (name === BROWSER_TOOLS.CLOSE || !tool.execute) continue;
      const execute = tool.execute;
      tool.execute = (input, context) => {
        const generation = this.owner.generation;
        const next = this.pending
          .catch(() => {})
          .then(() => {
            if (generation !== this.owner.generation || this.released)
              throw new Error('Browser closed');
            return execute(input, context);
          });
        this.pending = next;
        return next;
      };
    }
    return tools;
  }

  // Page-manager events handle all transitions, including popup and window.close().
  protected override async reconnectScreencastForThread() {}
  override async startScreencast(options?: ScreencastOptions) {
    const manager = await this.getManagerForThread(options?.threadId);
    let cdp: CDPSession | undefined;
    const stream = new ScreencastStreamImpl(
      {
        getCdpSession: async () => {
          await cdp?.detach().catch(() => {});
          const page = manager.getPage();
          cdp = await page.context().newCDPSession(page);
          return cdp;
        },
        isBrowserRunning: () => manager.isLaunched(),
      },
      options,
    );
    const key = this.getStreamKey(this.threadId);
    await this.activeScreencastStreams.get(key)?.stop();
    this.activeScreencastStreams.set(key, stream);
    let pending = Promise.resolve();
    let stopped = false;
    const stop = stream.stop.bind(stream);
    stream.stop = async () => {
      stopped = true;
      await pending.catch(() => {});
      await stop();
      await cdp?.detach().catch(() => {});
      cdp = undefined;
    };
    const active = () => {
      pending = pending
        .catch(() => {})
        .then(async () => {
          if (stopped) return;
          if (!manager.isLaunched()) {
            await stop();
            return;
          }
          await stream.reconnect();
        });
      void pending.catch(() => {
        if (!stopped) void stream.stop();
      });
    };
    const url = (value: string) => stream.emitUrl(value);
    manager.events.on('active', active);
    manager.events.on('url', url);
    stream.once('stop', () => {
      stopped = true;
      manager.events.off('active', active);
      manager.events.off('url', url);
      if (this.activeScreencastStreams.get(key) === stream)
        this.activeScreencastStreams.delete(key);
    });
    pending = stream.start();
    try {
      await pending;
    } catch (error) {
      await stream.stop();
      throw error;
    }
    return stream;
  }
}
