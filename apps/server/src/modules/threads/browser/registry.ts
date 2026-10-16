import type { BrowserEvent } from '@aime/shared/browser';
import { emptyBrowserState } from '@aime/shared/browser';
import type { BrowserContext } from '@mastra/core/browser';
import { ThreadBrowserRouter } from '../browser.js';
import { UserBrowser } from './user-browser.js';
import {
  createBrowserDriver,
  ThreadBrowserSession,
  type BrowserDriver,
} from './session.js';

/** Threads own page sets; users own persistent browser processes and profiles. */
export class ThreadBrowsers {
  private sessions = new Map<
    string,
    { userId: string; session: ThreadBrowserSession }
  >();
  private users = new Map<string, UserBrowser>();
  private watchers = new Map<string, Set<() => void>>();
  constructor(
    private profilesRoot: string,
    private create: (
      threadId: string,
      owner: UserBrowser,
    ) => BrowserDriver = createBrowserDriver,
  ) {}

  private key(id: string, userId: string) {
    return JSON.stringify([userId, id]);
  }
  get(id: string, userId: string) {
    return this.sessions.get(this.key(id, userId))?.session;
  }
  *entries(userId: string) {
    for (const entry of this.sessions.values())
      if (entry.userId === userId)
        yield [entry.session.threadId, entry.session] as const;
  }
  forThread(id: string, defaultUserId: string) {
    return new ThreadBrowserRouter(
      (userId) => this.acquire(id, userId).browser,
      defaultUserId,
    );
  }
  agentContext(id: string, userId: () => string): BrowserContext {
    return {
      provider: 'vercel-labs/agent-browser',
      providerType: 'sdk',
      headless: true,
      isOpen: false,
      getState: async () => {
        const session = this.get(id, userId());
        const state = session?.isRunning() ? await session.state() : undefined;
        return {
          isOpen: state?.status === 'ready',
          currentUrl: state?.url,
          pageTitle: state?.tabs[state.activeTabIndex]?.title,
          tabCount: state?.tabs.length ?? 0,
        };
      },
    };
  }
  acquire(id: string, userId: string) {
    const key = this.key(id, userId);
    let session = this.sessions.get(key)?.session;
    if (!session) {
      let owner = this.users.get(userId);
      if (!owner)
        this.users.set(
          userId,
          (owner = new UserBrowser(this.profilesRoot, userId)),
        );
      session = new ThreadBrowserSession(id, this.create(id, owner));
      this.sessions.set(key, { userId, session });
      for (const update of this.watchers.get(key) ?? []) update();
    }
    return session;
  }

  subscribe(
    id: string,
    userId: string,
    listener: (event: BrowserEvent) => void,
  ) {
    const key = this.key(id, userId);
    let unsubscribe: (() => void) | undefined;
    const update = () => {
      unsubscribe?.();
      const session = this.get(id, userId);
      unsubscribe = session?.subscribe(listener);
      if (!session) listener({ type: 'state', state: emptyBrowserState });
    };
    let watchers = this.watchers.get(key);
    if (!watchers) this.watchers.set(key, (watchers = new Set()));
    watchers.add(update);
    update();
    return () => {
      unsubscribe?.();
      watchers.delete(update);
      if (!watchers.size) this.watchers.delete(key);
    };
  }

  async releaseInactive(id: string) {
    for (const entry of this.sessions.values())
      if (entry.session.threadId === id && !entry.session.isRunning())
        await this.removeSession(entry.session, entry.userId);
  }
  private async removeSession(session: ThreadBrowserSession, userId: string) {
    const key = this.key(session.threadId, userId);
    this.sessions.delete(key);
    for (const update of this.watchers.get(key) ?? []) update();
    await session.dispose();
  }
  async remove(id: string) {
    await Promise.all(
      [...this.sessions.values()]
        .filter((entry) => entry.session.threadId === id)
        .map((entry) => this.removeSession(entry.session, entry.userId)),
    );
  }
  async dispose() {
    await Promise.all([...this.users.values()].map((owner) => owner.close()));
    await Promise.allSettled(
      [...this.sessions.values()].map((entry) =>
        this.removeSession(entry.session, entry.userId),
      ),
    );
    this.watchers.clear();
    this.users.clear();
  }
}
