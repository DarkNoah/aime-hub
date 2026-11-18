import type { BrowserEvent } from '@aime/shared/browser';
import { emptyBrowserState } from '@aime/shared/browser';
import { ThreadError } from '../errors.js';
import type { BrowserExecBinding } from './exec-actions.js';
export type { BrowserExecBinding } from './exec-actions.js';
import { UserBrowser } from './user-browser.js';
import {
  createBrowserDriver,
  ThreadBrowserSession,
  type BrowserDriver,
} from './session.js';

/** Threads own pages; each user has separate personal and project browser profiles. */
export class ThreadBrowsers {
  private sessions = new Map<
    string,
    { userId: string; projectId?: string; session: ThreadBrowserSession }
  >();
  private owners = new Map<string, UserBrowser>();
  private watchers = new Map<string, Set<() => void>>();
  constructor(
    private profilesRoot: string,
    private create: (
      threadId: string,
      owner: UserBrowser,
    ) => BrowserDriver = createBrowserDriver,
    private getEnvironment?: (
      userId: string,
      projectId?: string,
    ) => Promise<Record<string, string>>,
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
  execForThread(
    id: string,
    userId: string,
    projectId?: string,
  ): BrowserExecBinding {
    return async (operation, input, signal) => {
      signal?.throwIfAborted();
      const entry = this.sessions.get(this.key(id, userId));
      if (entry && entry.projectId !== projectId)
        throw new Error('Browser thread scope mismatch');
      if (!entry && operation !== 'goto' && operation !== 'newTab') {
        if (operation === 'tabs') return [];
        if (operation === 'close')
          return this.owners
            .get(JSON.stringify([userId, projectId ?? null]))
            ?.close();
        throw new ThreadError('BROWSER_NOT_RUNNING', 409);
      }
      return (entry?.session ?? this.acquire(id, userId, projectId)).exec(
        operation,
        input,
        signal,
      );
    };
  }
  acquire(id: string, userId: string, projectId?: string) {
    const key = this.key(id, userId);
    const entry = this.sessions.get(key);
    if (entry && entry.projectId !== projectId)
      throw new Error('Browser thread scope mismatch');
    let session = entry?.session;
    if (!session) {
      const ownerKey = JSON.stringify([userId, projectId ?? null]);
      let owner = this.owners.get(ownerKey);
      if (!owner)
        this.owners.set(
          ownerKey,
          (owner = new UserBrowser(
            this.profilesRoot,
            userId,
            this.getEnvironment,
            projectId,
          )),
        );
      session = new ThreadBrowserSession(id, this.create(id, owner));
      this.sessions.set(key, { userId, projectId, session });
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
    await Promise.all([...this.owners.values()].map((owner) => owner.close()));
    await Promise.allSettled(
      [...this.sessions.values()].map((entry) =>
        this.removeSession(entry.session, entry.userId),
      ),
    );
    this.watchers.clear();
    this.owners.clear();
  }
}
