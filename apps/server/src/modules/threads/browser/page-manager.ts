import { EventEmitter } from 'node:events';
import { BrowserManager } from 'agent-browser';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';

/** Reuse agent-browser's snapshots, refs and input, with a thread-local page set. */
export class ThreadPageManager extends BrowserManager {
  readonly events = new EventEmitter();
  private owned: Page[] = [];
  private active?: Page;
  private disposed = false;
  private inputSessions = new Map<Page, Promise<CDPSession>>();

  constructor(private readonly context: BrowserContext) {
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
    for (const key of Object.keys(this.getRefMap()))
      delete this.getRefMap()[key];
    this.setLastSnapshot('');
    this.switchToMainFrame();
  }

  private changed() {
    this.invalidateRefs();
    this.events.emit('active');
  }

  private track(page: Page) {
    if (this.disposed) {
      void page.close().catch(() => {});
      return;
    }
    if (this.owned.includes(page)) return;
    this.owned.push(page);
    this.active = page;
    // A popup belongs to its opener's thread, never whichever thread last ran a tool.
    page.on('popup', (popup) => this.track(popup));
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
  }

  override async newTab() {
    if (this.disposed) throw new Error('Browser closed');
    const page = await this.context.newPage();
    this.track(page);
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
  override async getCDPSession() {
    const page = this.getPage();
    let session = this.inputSessions.get(page);
    if (!session) {
      session = this.context.newCDPSession(page);
      this.inputSessions.set(page, session);
      void session.catch(() => this.inputSessions.delete(page));
    }
    return session;
  }
}
