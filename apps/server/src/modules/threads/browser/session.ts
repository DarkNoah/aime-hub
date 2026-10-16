import type { MastraBrowser, ScreencastStream } from '@mastra/core/browser';
import type {
  BrowserAction,
  BrowserEvent,
  BrowserFrame,
  BrowserState,
} from '@aime/shared/browser';
import { emptyBrowserState } from '@aime/shared/browser';
import { ThreadBrowser } from '../browser.js';
import type { UserBrowser } from './user-browser.js';
import { ThreadError } from '../errors.js';

/** Keep provider-specific navigation and text insertion outside the stream lifecycle. */
export function createBrowserDriver(threadId: string, owner: UserBrowser) {
  const browser = new ThreadBrowser(owner, threadId);
  return {
    browser,
    dispose: () => browser.release(),
    async action(action: BrowserAction) {
      if (action.kind === 'close') {
        await browser.closeThreadSession(threadId);
        return;
      }
      if (
        !browser.hasThreadSession(threadId) ||
        !browser.isBrowserRunning(threadId)
      )
        throw new ThreadError('BROWSER_NOT_RUNNING', 409);
      if (action.kind === 'mouse')
        return browser.injectMouseEvent(action.event, threadId);
      if (action.kind === 'keyboard')
        return browser.injectKeyboardEvent(action.event, threadId);
      const manager = await browser.getManagerForThread(threadId);
      if (action.kind === 'text') {
        // CDP char events accept a single character. insertText supports paste and IME commits.
        await (
          await manager.getCDPSession()
        ).send('Input.insertText', { text: action.text });
        return;
      }
      if (action.kind === 'tab') {
        const result = await browser.tabs(
          { action: 'switch', index: action.index },
          threadId,
        );
        if (!result.success)
          throw new ThreadError('BROWSER_ACTION_FAILED', 502);
        return;
      }
      const page = manager.getPage();
      const options = {
        timeout: 15000,
        waitUntil: 'domcontentloaded' as const,
      };
      if (action.kind === 'navigate') await page.goto(action.url, options);
      else if (action.kind === 'reload') await page.reload(options);
      else if (action.kind === 'back') await page.goBack(options);
      else if (action.kind === 'forward') await page.goForward(options);
    },
    async capture(): Promise<BrowserFrame> {
      const page = (await browser.getManagerForThread(threadId)).getPage();
      const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
      const data = await page.screenshot({
        type: 'jpeg',
        quality: 65,
        timeout: 5000,
      });
      return { data: data.toString('base64'), viewport };
    },
  };
}

export type BrowserDriver = {
  browser: MastraBrowser;
  action(action: BrowserAction): Promise<void>;
  capture(): Promise<BrowserFrame>;
  dispose?(): Promise<void>;
};

/** One CDP stream per thread, independent of the number of viewers or chat sessions. */
export class ThreadBrowserSession {
  readonly browser: MastraBrowser;
  private listeners = new Set<(event: BrowserEvent) => void>();
  private stream?: ScreencastStream;
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private lastFrame?: BrowserFrame;
  private frameAt = 0;
  private frameTimer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private wasRunning = false;
  private unsubscribeClosed?: () => void;

  constructor(
    readonly threadId: string,
    private driver: BrowserDriver,
  ) {
    this.browser = driver.browser;
    this.unsubscribeClosed = this.browser.onBrowserClosed?.(() => {
      this.wasRunning = true;
      this.emit({
        type: 'state',
        state: { ...emptyBrowserState, status: 'closed' },
      });
      void this.serial(() => this.stopStream()).catch(() => {});
    }, threadId);
  }

  isRunning() {
    return (
      !this.disposed &&
      this.browser.hasThreadSession(this.threadId) &&
      this.browser.isBrowserRunning(this.threadId)
    );
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {}).then(work);
    this.pending = next;
    return next;
  }

  async state(): Promise<BrowserState> {
    const running = this.isRunning();
    const state = running
      ? await this.browser.getBrowserState(this.threadId)
      : null;
    return {
      ...emptyBrowserState,
      status: running ? 'ready' : this.wasRunning ? 'closed' : 'waiting',
      url: state?.tabs[state.activeTabIndex]?.url ?? '',
      tabs: state?.tabs ?? [],
      activeTabIndex: state?.activeTabIndex ?? 0,
    };
  }

  private emit(event: BrowserEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private async stopStream() {
    clearTimeout(this.frameTimer);
    this.frameTimer = undefined;
    const stream = this.stream;
    this.stream = undefined;
    this.lastFrame = undefined;
    await stream?.stop();
  }

  private refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.serial(async () => {
      if (this.disposed || !this.listeners.size) {
        await this.stopStream();
        return;
      }
      const state = await this.state();
      this.emit({ type: 'state', state });
      if (state.status !== 'ready') {
        await this.stopStream();
        return;
      }
      this.wasRunning = true;
      if (this.stream?.isActive()) return;
      await this.stopStream();
      const stream = await this.browser.startScreencastIfBrowserActive({
        threadId: this.threadId,
        format: 'jpeg',
        quality: 65,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 2,
      });
      if (!stream) return;
      this.stream = stream;
      stream.on('frame', (frame) => {
        if (this.stream !== stream || this.disposed) return;
        const now = Date.now();
        this.lastFrame = frame;
        const deliver = () => {
          this.frameTimer = undefined;
          this.frameAt = Date.now();
          if (this.lastFrame && this.stream === stream && !this.disposed)
            this.emit({ type: 'frame', frame: this.lastFrame });
        };
        if (now - this.frameAt >= 80) deliver();
        else this.frameTimer ??= setTimeout(deliver, 80 - (now - this.frameAt));
      });
      stream.on('error', () => {
        if (this.stream === stream) {
          this.emit({ type: 'state', state: { ...state, status: 'error' } });
          void this.serial(() => this.stopStream()).catch(() => {});
        }
      });
      // Seed static pages and late subscribers; CDP may emit its first frame before start resolves.
      const frame = await this.driver.capture();
      if (this.stream === stream) {
        this.lastFrame = frame;
        this.emit({ type: 'frame', frame });
      }
    })
      .catch(() => {
        this.emit({
          type: 'state',
          state: { ...emptyBrowserState, status: 'error' },
        });
        void this.serial(() => this.stopStream()).catch(() => {});
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  subscribe(listener: (event: BrowserEvent) => void) {
    this.listeners.add(listener);
    if (this.lastFrame && this.isRunning())
      listener({ type: 'frame', frame: this.lastFrame });
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), 1000);
      this.timer.unref();
    }
    void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearInterval(this.timer);
        this.timer = undefined;
        void this.serial(async () => {
          if (!this.listeners.size) await this.stopStream();
        }).catch(() => {});
      }
    };
  }

  async action(action: BrowserAction) {
    await this.serial(async () => {
      if (this.disposed) throw new ThreadError('BROWSER_NOT_RUNNING', 409);
      if (action.kind === 'close') await this.stopStream();
      await this.driver.action(action);
    });
    // Input must not wait for another screenshot or state query.
    if (!['mouse', 'keyboard', 'text'].includes(action.kind))
      void this.refresh();
  }

  async dispose() {
    this.disposed = true;
    this.unsubscribeClosed?.();
    clearInterval(this.timer);
    await this.serial(async () => {
      await this.stopStream();
      if (this.driver.dispose) await this.driver.dispose();
      else await this.browser.close();
      this.emit({
        type: 'state',
        state: { ...emptyBrowserState, status: 'closed' },
      });
      this.listeners.clear();
    });
  }
}
