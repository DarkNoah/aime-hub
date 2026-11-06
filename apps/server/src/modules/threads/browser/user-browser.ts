import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Cookie } from 'playwright-core';
import { chromium } from '../../../lib/browser.js';
import { ThreadPageManager } from './page-manager.js';
import { recoverBrowserProfileLock } from './profile-lock.js';
import { browserProxy } from './proxy.js';
import { browserOperation } from './operation.js';

/** One persistent Chromium context per user and scope, outside chat workspaces. */
export class UserBrowser {
  private context?: BrowserContext;
  private managers = new Map<string, ThreadPageManager>();
  private pending: Promise<unknown> = Promise.resolve();
  private closedListeners = new Set<() => Promise<void>>();
  private epoch = 0;
  private closing?: Promise<void>;
  readonly directory: string;

  constructor(
    root: string,
    readonly userId: string,
    private getEnvironment?: (
      userId: string,
      projectId?: string,
    ) => Promise<Record<string, string>>,
    readonly projectId?: string,
  ) {
    if (!userId) throw new Error('Browser owner is required');
    this.directory = join(
      projectId
        ? join(
            root,
            'projects',
            createHash('sha256').update(projectId).digest('hex'),
          )
        : root,
      createHash('sha256').update(userId).digest('hex'),
    );
  }

  get generation() {
    return this.epoch;
  }
  get isClosing() {
    return !!this.closing;
  }
  get(threadId: string) {
    return this.managers.get(threadId);
  }
  onClosed(listener: () => Promise<void>) {
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }
  private serial<T>(work: () => Promise<T>) {
    const next = this.pending.catch(() => {}).then(work);
    this.pending = next;
    return next;
  }

  private async launch() {
    const proxy = browserProxy(
      (await this.getEnvironment?.(this.userId, this.projectId)) ?? {},
    );
    const profile = join(this.directory, 'profile');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await recoverBrowserProfileLock(profile);
    // Discard only session/tab recovery files, including after an unclean server exit.
    // Cookies, localStorage and IndexedDB remain in the persistent profile.
    for (const name of [
      'Sessions',
      'Current Session',
      'Current Tabs',
      'Last Session',
      'Last Tabs',
    ])
      await rm(join(profile, 'Default', name), {
        recursive: true,
        force: true,
      });
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: chromium.executablePath(),
      viewport: { width: 1280, height: 720 },
      proxy,
      args: ['--no-first-run', '--disable-session-crashed-bubble'],
    });
    try {
      // Session cookies need explicit persistence when Chromium is cleanly shut down.
      const path = join(this.directory, 'session-cookies.json');
      const saved = await readFile(path, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      if (saved) {
        await context.addCookies(JSON.parse(saved) as Cookie[]);
        await rm(path);
      }
      const pages = context.pages();
      const keeper = pages[0] ?? (await context.newPage());
      await keeper.goto('about:blank');
      await Promise.all(pages.slice(1).map((page) => page.close()));
      this.context = context;
      context.once('close', () => {
        if (this.context !== context) return;
        this.context = undefined;
        this.epoch++;
        this.managers.clear();
        // Explicit close already notified listeners before asking Chromium to
        // exit. Only an unexpected disconnect needs another notification.
        if (this.closing) return;
        for (const listener of this.closedListeners)
          void listener().catch(() => {});
      });
      return context;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  acquire(threadId: string) {
    const generation = this.epoch;
    return this.serial(async () => {
      if (generation !== this.epoch || this.closing)
        throw new Error('Browser closed');
      const context = this.context ?? (await this.launch());
      if (generation !== this.epoch) throw new Error('Browser closed');
      let manager = this.managers.get(threadId);
      if (!manager) {
        manager = new ThreadPageManager(context);
        this.managers.set(threadId, manager);
      }
      if (!manager.isLaunched()) await manager.newTab();
      return manager;
    });
  }

  release(threadId: string) {
    return this.serial(async () => {
      const manager = this.managers.get(threadId);
      this.managers.delete(threadId);
      await manager?.close();
    }).then(async () => {
      if (!this.managers.size) await this.close();
    });
  }

  close() {
    if (this.closing) return this.closing;
    this.epoch++;
    this.closing = this.serial(async () => {
      const context = this.context;
      // Stream listeners can themselves be waiting on Chromium. They must not
      // prevent context.close(), which interrupts those pending CDP commands.
      void Promise.allSettled(
        [...this.closedListeners].map((listener) =>
          browserOperation(
            'notify browser closed',
            Promise.resolve().then(listener),
            2_000,
          ),
        ),
      );
      if (!context) return;
      // Save only session cookies here; persistent cookies and origin storage stay in Chromium.
      try {
        const cookies = (
          await browserOperation(
            'save session cookies',
            context.cookies(),
            2_000,
          )
        ).filter((cookie) => cookie.expires === -1);
        const path = join(this.directory, 'session-cookies.json');
        await writeFile(`${path}.tmp`, JSON.stringify(cookies), {
          mode: 0o600,
        });
        await rename(`${path}.tmp`, path);
      } catch (error) {
        // Keep the persistent profile and any previous session-cookie backup.
        // Failure to read cookies must not prevent shutdown.
        console.warn(
          'Could not save browser session cookies',
          error instanceof Error ? error.message : 'Unknown error',
        );
      } finally {
        // Retain the context on failure so a later close can retry; do not report
        // a successful shutdown or launch a second process against its profile.
        await browserOperation(
          'close Chromium context',
          context.close(),
          5_000,
        );
        if (this.context === context) this.context = undefined;
        this.managers.clear();
      }
    }).finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
