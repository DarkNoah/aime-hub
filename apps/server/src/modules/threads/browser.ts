import { AgentBrowser, AgentBrowserThreadManager } from '@mastra/agent-browser';
import {
  ScreencastStreamImpl,
  type ScreencastOptions,
} from '@mastra/core/browser';
import type { CDPSession } from 'playwright-core';
import { UserBrowser } from './browser/user-browser.js';
import { browserOperation } from './browser/operation.js';

/** Mastra routes threads; the context belongs to this user in the current scope. */
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
  private opening?: Promise<void>;
  private released = false;

  constructor(
    private owner: UserBrowser,
    private threadId: string,
  ) {
    let manager!: ThreadBrowserManager;
    super({
      headless: true,
      // Tools and streams route by thread; UserBrowser shares its process within one user/scope.
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
    const streams = [...this.activeScreencastStreams.values()];
    this.activeScreencastStreams.clear();
    // Notify before asynchronous teardown. A late stop must never reset a newly
    // reopened browser or clear its streams.
    this.notifyBrowserClosed(this.threadId);
    await Promise.allSettled(streams.map((stream) => stream.stop()));
  }
  /** Thread cleanup releases its pages; explicit close ends the user's browser in this scope. */
  async release() {
    this.released = true;
    this.unsubscribe();
    await this.reset();
    await this.owner.release(this.threadId);
  }

  // Page-manager events handle all transitions, including popup and window.close().
  protected override async reconnectScreencastForThread() {}
  override async startScreencast(options?: ScreencastOptions) {
    const manager = await this.getManagerForThread(options?.threadId);
    let cdp: CDPSession | undefined;
    let stopped = false;
    const stream = new ScreencastStreamImpl(
      {
        getCdpSession: async () => {
          if (stopped) throw new Error('Screencast closed');
          if (cdp)
            await browserOperation(
              'detach previous screencast',
              cdp.detach(),
              2_000,
            ).catch(() => {});
          if (stopped) throw new Error('Screencast closed');
          const page = manager.getPage();
          const session = await page.context().newCDPSession(page);
          if (stopped) {
            void browserOperation(
              'detach stale screencast',
              session.detach(),
              2_000,
            ).catch(() => {});
            throw new Error('Screencast closed');
          }
          cdp = session;
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
    let stopping: Promise<void> | undefined;
    const stop = stream.stop.bind(stream);
    stream.stop = () => {
      if (stopping) return stopping;
      stopped = true;
      cleanup();
      stopping = (async () => {
        // Do not wait for start/reconnect: detaching CDP interrupts that work.
        try {
          await browserOperation('stop CDP screencast', stop(), 2_000);
        } finally {
          const session = cdp;
          cdp = undefined;
          if (session)
            await browserOperation(
              'detach screencast',
              session.detach(),
              2_000,
            ).catch(() => {});
        }
      })();
      return stopping;
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
          await browserOperation(
            'reconnect screencast',
            resume(stream.reconnect()),
          );
        });
      void pending.catch(() => {
        if (!stopped) void stream.stop().catch(() => {});
      });
    };
    const url = (value: string) => stream.emitUrl(value);
    manager.events.on('active', active);
    manager.events.on('url', url);
    const cleanup = () => {
      stopped = true;
      manager.events.off('active', active);
      manager.events.off('url', url);
      if (this.activeScreencastStreams.get(key) === stream)
        this.activeScreencastStreams.delete(key);
    };
    stream.once('stop', cleanup);
    const resume = async (operation: Promise<void>) => {
      await operation;
      if (stopped) {
        await browserOperation('stop late screencast', stop(), 2_000).catch(
          () => {},
        );
        throw new Error('Screencast closed');
      }
    };
    pending = browserOperation('start screencast', resume(stream.start()));
    try {
      await pending;
    } catch (error) {
      await stream.stop().catch(() => {});
      throw error;
    }
    return stream;
  }
}
