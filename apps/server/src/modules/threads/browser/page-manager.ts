import { EventEmitter } from 'node:events';
import { BrowserManager } from 'agent-browser';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { browserOperation } from './operation.js';

type Viewport = NonNullable<ReturnType<Page['viewportSize']>>;

/** Reuse agent-browser's snapshots, refs and input, with a thread-local page set. */
export class ThreadPageManager extends BrowserManager {
  readonly events = new EventEmitter();
  private owned: Page[] = [];
  private active?: Page;
  private disposed = false;
  private revision = 0;
  private inputSessions = new Map<Page, Promise<CDPSession>>();
  private viewport?: Viewport;
  private pageResizes = new WeakMap<
    Page,
    { size: Viewport; done: Promise<void> }
  >();

  constructor(
    private readonly context: BrowserContext,
    private readonly onPage?: (page: Page) => void,
  ) {
    super();
  }

  override isLaunched() {
    return !this.disposed && this.getPages().length > 0;
  }
  override getContext() {
    return this.context;
  }
  override getBrowser() {
    return this.context.browser();
  }
  override getPages() {
    return this.owned.filter((page) => !page.isClosed());
  }
  override getPage() {
    const page = this.active;
    if (this.disposed || !page || page.isClosed())
      throw new Error('Browser not running for this thread');
    return page;
  }
  override getActiveIndex() {
    return Math.max(0, this.getPages().indexOf(this.active!));
  }

  private invalidateRefs() {
    this.revision++;
    for (const key of Object.keys(this.getRefMap()))
      delete this.getRefMap()[key];
    this.setLastSnapshot('');
    this.switchToMainFrame();
  }

  private changed() {
    this.invalidateRefs();
    this.events.emit('active');
  }

  private async applyViewport(page: Page) {
    const size = this.viewport;
    if (!size) return;
    const last = this.pageResizes.get(page);
    if (last?.size === size) return last.done;
    // Popup setup can overlap a panel resize. Keep writes ordered for each page.
    const done = (last?.done ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (!this.disposed && !page.isClosed() && this.viewport === size) {
          // Playwright's setViewportSize also resizes the native window shared with other threads.
          // Only change this target's layout and compositor surface.
          const cdp = await this.inputSession(page);
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            ...size,
            screenWidth: size.width,
            screenHeight: size.height,
            mobile: false,
            deviceScaleFactor: 1,
          });
        }
      });
    this.pageResizes.set(page, { size, done });
    try {
      await done;
    } catch (error) {
      if (this.pageResizes.get(page)?.done === done)
        this.pageResizes.delete(page);
      if (!page.isClosed() && !this.disposed) throw error;
    }
  }

  override async setViewport(width: number, height: number) {
    if (this.viewport?.width !== width || this.viewport.height !== height)
      this.viewport = { width, height };
    await Promise.all(this.getPages().map((page) => this.applyViewport(page)));
  }

  async captureViewport(format: 'jpeg' | 'png', signal?: AbortSignal) {
    const page = this.getPage();
    const viewport = this.viewport ??
      page.viewportSize() ?? { width: 1280, height: 720 };
    const quality = format === 'jpeg' ? 65 : undefined;
    const timeout = format === 'jpeg' ? 5000 : 15000;
    if (!this.viewport) {
      const data = await page.screenshot({
        type: format,
        quality,
        timeout,
        signal,
      });
      return { data: data.toString('base64'), viewport };
    }
    // The driver's cached viewport still describes the unmodified native window.
    await this.applyViewport(page);
    signal?.throwIfAborted();
    const cdp = await this.inputSession(page);
    const { data } = await browserOperation(
      'capture resized viewport',
      cdp.send('Page.captureScreenshot', { format, quality }),
      timeout,
    );
    return { data, viewport };
  }

  private async track(page: Page) {
    if (this.disposed) {
      void page.close().catch(() => {});
      return;
    }
    if (this.owned.includes(page)) return;
    this.owned.push(page);
    this.onPage?.(page);
    this.active = page;
    // A popup belongs to its opener's thread, never whichever thread last ran a tool.
    page.on('popup', (popup) => {
      void this.track(popup).catch((error: unknown) =>
        console.warn('Could not apply the thread viewport to the popup', error),
      );
    });
    page.on('framenavigated', (frame) => {
      if (page === this.active && frame === page.mainFrame()) {
        this.invalidateRefs();
        this.events.emit('url', page.url());
      }
    });
    page.once('close', () => {
      const input = this.inputSessions.get(page);
      this.inputSessions.delete(page);
      void input?.then((session) => session.detach()).catch(() => {});
      this.owned = this.owned.filter((item) => item !== page);
      if (this.active === page) {
        this.active = this.owned.at(-1);
        this.changed();
      }
    });
    this.changed();
    await this.applyViewport(page);
  }

  override async getSnapshot(
    options?: Parameters<BrowserManager['getSnapshot']>[0],
    signal?: AbortSignal,
  ) {
    const revision = ++this.revision;
    const result = await super.getSnapshot(options);
    // The user may navigate or switch tabs while Chromium is collecting the tree.
    if (this.revision !== revision || this.disposed || signal?.aborted) {
      this.invalidateRefs();
      signal?.throwIfAborted();
      throw new Error('Page changed during the snapshot. Take a new snapshot.');
    }
    return result;
  }

  async openPage(signal?: AbortSignal) {
    if (this.disposed) throw new Error('Browser closed');
    const page = await this.context.newPage();
    try {
      signal?.throwIfAborted();
      if (this.disposed) throw new Error('Browser closed');
      await this.track(page);
      signal?.throwIfAborted();
      if (this.disposed || page.isClosed()) throw new Error('Browser closed');
      return page;
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  override async newTab() {
    await this.openPage();
    return { index: this.getActiveIndex(), total: this.getPages().length };
  }
  override async switchTo(index: number) {
    const page = this.getPages()[index];
    if (!Number.isInteger(index) || !page) throw new Error('Invalid tab index');
    if (page !== this.active) {
      this.active = page;
      this.changed();
    }
    return { index, url: page.url(), title: await page.title() };
  }
  override async closeTab(index = this.getActiveIndex()) {
    const page = this.getPages()[index];
    if (!Number.isInteger(index) || !page) throw new Error('Invalid tab index');
    await page.close();
    return { closed: index, remaining: this.getPages().length };
  }
  override async listTabs() {
    return Promise.all(
      this.getPages().map(async (page, index) => ({
        index,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: page === this.active,
      })),
    );
  }
  override async close() {
    this.disposed = true;
    await Promise.allSettled(
      [...this.inputSessions.values()].map(async (session) =>
        (await session).detach(),
      ),
    );
    this.inputSessions.clear();
    await Promise.all(this.getPages().map((page) => page.close()));
    this.owned = [];
    this.active = undefined;
    this.events.removeAllListeners();
  }
  private inputSession(page: Page) {
    let session = this.inputSessions.get(page);
    if (!session) {
      session = this.context.newCDPSession(page);
      this.inputSessions.set(page, session);
      void session.catch(() => this.inputSessions.delete(page));
    }
    return session;
  }
  override async getCDPSession() {
    return this.inputSession(this.getPage());
  }
}
