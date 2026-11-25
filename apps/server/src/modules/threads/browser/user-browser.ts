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
import { chromium, type BrowserContext, type Cookie } from 'patchright-core';
import type { BrowserContext as AgentBrowserContext } from 'playwright-core';
import { ThreadPageManager } from './page-manager.js';
import { NetworkCaptureEvents } from './network-events.js';
import type { NetworkCaptureStore } from './network-store.js';
import { recoverBrowserProfileLock } from './profile-lock.js';
import { browserProxy } from './proxy.js';
import { browserOperation } from './operation.js';

const BROWSER_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

// Patchright 1.64.3 passes these features in one switch. ignoreDefaultArgs
// matches the whole argument, so replace it while retaining the other defaults.
const driverDisabledFeatures = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
];
const chatDisabledFeatures = driverDisabledFeatures.filter(
  (feature) => feature !== 'ThirdPartyStoragePartitioning',
);

export function chatBrowserLaunchOptions(env: NodeJS.ProcessEnv = process.env) {
  const launcher = env.CHAT_BROWSER_HEADED_EXECUTABLE;
  const headless =
    env.CHAT_BROWSER_HEADLESS === 'true' ||
    (env.CHAT_BROWSER_HEADLESS !== 'false' && env.NODE_ENV !== 'production');
  return {
    headless,
    executablePath: (!headless && launcher) || chromium.executablePath(),
  };
}

/** One persistent Chromium context per personal user or project. */
export class UserBrowser {
  private context?: BrowserContext;
  private network?: NetworkCaptureEvents;
  private managers = new Map<string, Map<string, ThreadPageManager>>();
  private pending: Promise<unknown> = Promise.resolve();
  private closedListeners = new Map<() => Promise<void>, string>();
  private epoch = 0;
  private closing?: Promise<void>;
  private closingUsers = new Map<string, Promise<void>>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private activeOperations = new Set<symbol>();
  readonly directory: string;
  readonly launchOptions = chatBrowserLaunchOptions();

  constructor(
    root: string,
    readonly userId: string,
    private getEnvironment?: (
      userId: string,
      projectId?: string,
    ) => Promise<Record<string, string>>,
    readonly projectId?: string,
    private readonly captures?: NetworkCaptureStore,
  ) {
    if (!userId) throw new Error('Browser owner is required');
    this.directory = projectId
      ? join(
          root,
          'projects',
          createHash('sha256').update(projectId).digest('hex'),
        )
      : join(root, createHash('sha256').update(userId).digest('hex'));
  }

  get generation() {
    return this.epoch;
  }
  get isClosing() {
    return !!this.closing;
  }
  isClosingForUser(userId: string) {
    return this.isClosing || this.closingUsers.has(userId);
  }
  get(threadId: string, userId = this.userId) {
    return this.managers.get(userId)?.get(threadId);
  }
  onClosed(listener: () => Promise<void>, userId = this.userId) {
    this.closedListeners.set(listener, userId);
    return () => this.closedListeners.delete(listener);
  }
  private notifyClosed(userId?: string) {
    // CDP shutdown must not wait for screencast listeners.
    for (const [listener, listenerUserId] of this.closedListeners)
      if (userId === undefined || userId === listenerUserId)
        void browserOperation(
          'notify browser closed',
          Promise.resolve().then(listener),
          2_000,
        ).catch(() => {});
  }
  private serial<T>(work: () => Promise<T>) {
    const next = this.pending.catch(() => {}).then(work);
    this.pending = next;
    return next;
  }

  private clearIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleClose() {
    this.clearIdleTimer();
    if (!this.context || this.closing || this.activeOperations.size) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.close().catch((error: unknown) => {
        console.warn(
          'Could not close idle browser',
          error instanceof Error ? error.message : 'Unknown error',
        );
      });
    }, BROWSER_IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  /** Only requested browser operations count as use; state/preview polling does not. */
  async withActivity<T>(
    work: () => Promise<T>,
    userId = this.userId,
  ): Promise<T> {
    if (this.isClosingForUser(userId)) throw new Error('Browser closed');
    const operation = Symbol();
    this.activeOperations.add(operation);
    this.clearIdleTimer();
    try {
      return await work();
    } finally {
      // Closing clears these tokens, so late operations cannot affect a new browser.
      if (this.activeOperations.delete(operation)) this.scheduleIdleClose();
    }
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
      ...this.launchOptions,
      viewport: { width: 1280, height: 720 },
      proxy,
      // Use Chromium's default third-party storage partitions for logged-in browsing.
      ignoreDefaultArgs: [
        '--disable-features=' + driverDisabledFeatures.join(','),
      ],
      args: [
        '--no-first-run',
        '--disable-session-crashed-bubble',
        '--disable-features=' + chatDisabledFeatures.join(','),
      ],
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
      if (this.captures)
        this.network = new NetworkCaptureEvents(
          context as AgentBrowserContext,
          this.captures,
        );
      context.once('close', () => {
        if (this.context !== context) return;
        this.context = undefined;
        this.network = undefined;
        this.clearIdleTimer();
        this.activeOperations.clear();
        this.epoch++;
        this.managers.clear();
        // Explicit close already notified listeners before asking Chromium to
        // exit. Only an unexpected disconnect needs another notification.
        if (this.closing) return;
        this.captures?.stopScopeOwner(
          this.projectId ? undefined : this.userId,
          this.projectId,
        );
        this.notifyClosed();
      });
      return context;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  acquire(threadId: string, userId = this.userId) {
    const generation = this.epoch;
    return this.serial(async () => {
      if (generation !== this.epoch || this.isClosingForUser(userId))
        throw new Error('Browser closed');
      const context = this.context ?? (await this.launch());
      if (generation !== this.epoch || this.isClosingForUser(userId))
        throw new Error('Browser closed');
      let managers = this.managers.get(userId);
      if (!managers) this.managers.set(userId, (managers = new Map()));
      let manager = managers.get(threadId);
      if (!manager) {
        // agent-browser declares Playwright's recursive context types. Patchright
        // extends their evaluate signatures and implements the same page/CDP API.
        const network = this.network;
        const scope = {
          userId,
          projectId: this.projectId,
          threadId,
        };
        manager = new ThreadPageManager(
          context as AgentBrowserContext,
          (page) => network?.track(page, scope),
        );
        managers.set(threadId, manager);
      }
      if (!manager.isLaunched()) await manager.newTab();
      this.scheduleIdleClose();
      return manager;
    });
  }

  release(threadId: string, userId = this.userId) {
    return this.serial(async () => {
      const managers = this.managers.get(userId);
      const manager = managers?.get(threadId);
      managers?.delete(threadId);
      if (!managers?.size) this.managers.delete(userId);
      await manager?.close();
    }).then(async () => {
      if (
        !this.managers.size &&
        (!this.projectId || !this.activeOperations.size)
      )
        await this.close();
    });
  }

  closeForUser(userId: string) {
    if (!this.projectId || this.closing) return this.close();
    const pending = this.closingUsers.get(userId);
    if (pending) return pending;
    this.captures?.stopScopeOwner(userId, this.projectId);
    const closing = this.serial(async () => {
      const managers = this.managers.get(userId);
      this.managers.delete(userId);
      if (!managers) return;
      this.notifyClosed(userId);
      await Promise.all(
        [...managers.values()].map((manager) =>
          browserOperation(
            'close project browser pages',
            manager.close(),
            5_000,
          ),
        ),
      );
    })
      .then(async () => {
        if (!this.managers.size && !this.activeOperations.size)
          await this.close();
      })
      .finally(() => this.closingUsers.delete(userId));
    this.closingUsers.set(userId, closing);
    return closing;
  }

  close() {
    if (this.closing) return this.closing;
    this.captures?.stopScopeOwner(
      this.projectId ? undefined : this.userId,
      this.projectId,
    );
    this.clearIdleTimer();
    this.activeOperations.clear();
    this.epoch++;
    this.closing = this.serial(async () => {
      const context = this.context;
      this.notifyClosed();
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
      // A failed shutdown retains the context; retry after another idle interval.
      this.scheduleIdleClose();
    });
    return this.closing;
  }
}
