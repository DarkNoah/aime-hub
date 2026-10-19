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

/** One persistent Chromium context per user; profiles never live in chat workspaces. */
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
  ) {
    if (!userId) throw new Error('Browser owner is required');
    this.directory = join(
      root,
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
    const profile = join(this.directory, 'profile');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
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
      await Promise.allSettled(
        [...this.closedListeners].map((listener) => listener()),
      );
      if (!context) return;
      // Save only session cookies here; persistent cookies and origin storage stay in Chromium.
      try {
        const cookies = (await context.cookies()).filter(
          (cookie) => cookie.expires === -1,
        );
        const path = join(this.directory, 'session-cookies.json');
        await writeFile(`${path}.tmp`, JSON.stringify(cookies), {
          mode: 0o600,
        });
        await rename(`${path}.tmp`, path);
      } finally {
        this.context = undefined;
        try {
          await context.close();
        } finally {
          this.managers.clear();
        }
      }
    }).finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
