import type { BrowserEvent } from '@aime/shared/browser';
import { emptyBrowserState } from '@aime/shared/browser';
import { z } from 'zod';
import { ThreadError } from '../errors.js';
import { withAbortSignal } from '../../../lib/abort.js';
import type { BrowserExecBinding } from './exec-actions.js';
export type { BrowserExecBinding } from './exec-actions.js';
import { UserBrowser } from './user-browser.js';
import { NetworkCaptureStore } from './network-store.js';
import {
  createBrowserDriver,
  ThreadBrowserSession,
  type BrowserDriver,
} from './session.js';

const listFilters = z.object({
  pattern: z.string().optional(),
  url: z.string().optional(),
  method: z.string().optional(),
  status: z.number().int().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});
const readRequest = z.object({ id: z.string().min(1) });

const ownerKey = (userId: string, projectId?: string) =>
  projectId
    ? JSON.stringify(['project', projectId])
    : JSON.stringify(['user', userId]);

/** Sessions own pages; each personal user and each project has one profile. */
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
      userId: string,
    ) => BrowserDriver = createBrowserDriver,
    private getEnvironment?: (
      userId: string,
      projectId?: string,
    ) => Promise<Record<string, string>>,
    private captures = new NetworkCaptureStore(),
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
    { profileId = userId }: { profileId?: string } = {},
  ): BrowserExecBinding {
    const scope = { threadId: id, userId: profileId, projectId };
    return async (operation, input, signal) => {
      signal?.throwIfAborted();
      const entry = this.sessions.get(this.key(id, profileId));
      if (entry && entry.projectId !== projectId)
        throw new Error('Browser thread scope mismatch');
      // Recording can be armed before the first navigation. Reading it never
      // starts Chromium or extends its idle timeout.
      switch (operation) {
        case 'start':
          return this.captures.start(scope);
        case 'stop':
          return this.captures.stop(scope);
        case 'list':
          return withAbortSignal(signal, () =>
            this.captures.list(scope, listFilters.parse(input), signal),
          );
        case 'read':
          return withAbortSignal(signal, () =>
            this.captures.read(scope, readRequest.parse(input).id),
          );
      }
      if (!entry && operation !== 'goto' && operation !== 'newTab') {
        if (operation === 'tabs') return [];
        if (operation === 'close') {
          const owner = this.owners.get(ownerKey(profileId, projectId));
          if (owner) return owner.closeForUser(profileId);
          this.captures.stopScopeOwner(profileId, projectId);
          return;
        }
        throw new ThreadError('BROWSER_NOT_RUNNING', 409);
      }
      return (
        entry?.session ?? this.acquire(id, profileId, projectId, userId)
      ).exec(operation, input, signal);
    };
  }
  acquire(
    id: string,
    userId: string,
    projectId?: string,
    environmentUserId = userId,
  ) {
    const key = this.key(id, userId);
    const entry = this.sessions.get(key);
    if (entry && entry.projectId !== projectId)
      throw new Error('Browser thread scope mismatch');
    let session = entry?.session;
    if (!session) {
      const ownerId = ownerKey(userId, projectId);
      let owner = this.owners.get(ownerId);
      const getEnvironment = this.getEnvironment;
      if (!owner)
        this.owners.set(
          ownerId,
          (owner = new UserBrowser(
            this.profilesRoot,
            userId,
            getEnvironment &&
              (() => getEnvironment(environmentUserId, projectId)),
            projectId,
            this.captures,
          )),
        );
      session = new ThreadBrowserSession(id, this.create(id, owner, userId));
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
    await Promise.all([
      this.captures.removeThread(id),
      ...[...this.sessions.values()]
        .filter((entry) => entry.session.threadId === id)
        .map((entry) => this.removeSession(entry.session, entry.userId)),
    ]);
  }
  async dispose() {
    try {
      await Promise.all(
        [...this.owners.values()].map((owner) => owner.close()),
      );
      await Promise.allSettled(
        [...this.sessions.values()].map((entry) =>
          this.removeSession(entry.session, entry.userId),
        ),
      );
      this.watchers.clear();
      this.owners.clear();
    } finally {
      await this.captures.dispose();
    }
  }
}
