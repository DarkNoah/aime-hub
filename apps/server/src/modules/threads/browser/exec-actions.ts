import { z } from 'zod';
import type { ThreadBrowser } from '../browser.js';
import { ThreadError } from '../errors.js';
import type { ThreadPageManager } from './page-manager.js';

export type BrowserExecBinding = (
  operation: string,
  input: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

const target = z.string().min(1);
const index = z.number().int().nonnegative();
const url = z.string().min(1);
const request = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('goto'), url }),
  z.object({ operation: z.literal('newTab'), url: url.optional() }),
  z.object({ operation: z.literal('switchTab'), index }),
  z.object({ operation: z.literal('closeTab'), index: index.optional() }),
  z.object({ operation: z.literal('tabs') }),
  z.object({
    operation: z.literal('snapshot'),
    interactiveOnly: z.boolean().optional(),
    maxDepth: z.number().int().nonnegative().optional(),
  }),
  z.object({
    operation: z.literal('screenshot'),
    fullPage: z.boolean().optional(),
  }),
  z.object({ operation: z.literal('click'), target }),
  z.object({ operation: z.literal('fill'), target, value: z.string() }),
  z.object({ operation: z.literal('type'), target, text: z.string() }),
  z.object({ operation: z.literal('press'), key: z.string().min(1) }),
  z.object({ operation: z.literal('select'), target, value: z.string() }),
  z.object({ operation: z.literal('hover'), target }),
  z.object({
    operation: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().nonnegative().optional(),
  }),
  z.object({ operation: z.literal('back') }),
  z.object({ operation: z.literal('forward') }),
  z.object({ operation: z.literal('reload') }),
  z.object({
    operation: z.literal('dialog'),
    target,
    action: z.enum(['accept', 'dismiss']),
    text: z.string().optional(),
  }),
  z.object({
    operation: z.literal('wait'),
    target,
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
    timeout: z.number().int().positive().optional(),
  }),
  z.object({ operation: z.literal('drag'), source: target, target }),
  z.object({ operation: z.literal('evaluate'), script: z.string() }),
]);

function locator(manager: ThreadPageManager, target: string) {
  if (!manager.isRef(target)) return manager.getPage().locator(target);
  const result = manager.getLocatorFromRef(target);
  if (!result)
    throw new Error(`Unknown browser ref ${target}. Take a new snapshot.`);
  return result;
}

/** Only page data crosses the QuickJS boundary; every target is resolved in this thread. */
export function browserExecActions(browser: ThreadBrowser): BrowserExecBinding {
  return async (operation, input, signal) => {
    const args = request.parse({
      ...z.record(z.string(), z.unknown()).parse(input),
      operation,
    });
    signal?.throwIfAborted();
    const running = browser.isBrowserRunning();
    if (!running) {
      if (args.operation === 'tabs') return [];
      if (args.operation !== 'goto' && args.operation !== 'newTab')
        throw new ThreadError('BROWSER_NOT_RUNNING', 409);
      await browser.ensureReady();
    }
    const manager = await browser.getManagerForThread();
    signal?.throwIfAborted();
    const page = manager.getPage();
    const options = { timeout: 15_000, signal };
    const navigation = { ...options, waitUntil: 'domcontentloaded' as const };
    switch (args.operation) {
      case 'goto':
        await page.goto(args.url, navigation);
        return { url: page.url(), title: await page.title() };
      case 'newTab': {
        // A cold launch already created a page for this thread.
        const tab = running ? await manager.openPage(signal) : page;
        signal?.throwIfAborted();
        if (args.url) await tab.goto(args.url, navigation);
        return { index: manager.getPages().indexOf(tab), url: tab.url() };
      }
      case 'tabs':
        return manager.listTabs();
      case 'switchTab':
        return manager.switchTo(args.index);
      case 'closeTab':
        return manager.closeTab(args.index);
      case 'snapshot': {
        const { tree } = await manager.getSnapshot(
          {
            interactive: args.interactiveOnly ?? false,
            compact: true,
            maxDepth: args.maxDepth,
          },
          signal,
        );
        return tree.replace(/\[ref=(e\d+)\]/g, '@$1');
      }
      case 'screenshot': {
        const data = await page.screenshot({
          ...options,
          type: 'png',
          fullPage: args.fullPage,
        });
        return `data:image/png;base64,${data.toString('base64')}`;
      }
      case 'click':
        return locator(manager, args.target).click(options);
      case 'fill':
        return locator(manager, args.target).fill(args.value, options);
      case 'type':
        return locator(manager, args.target).pressSequentially(
          args.text,
          options,
        );
      case 'press':
        return page.keyboard.press(args.key);
      case 'select':
        return locator(manager, args.target).selectOption(
          { value: args.value },
          options,
        );
      case 'hover':
        return locator(manager, args.target).hover(options);
      case 'drag':
        return locator(manager, args.source).dragTo(
          locator(manager, args.target),
          options,
        );
      case 'wait':
        return locator(manager, args.target).waitFor({
          ...options,
          state: args.state,
          timeout: args.timeout ?? options.timeout,
        });
      case 'scroll': {
        const amount = args.amount ?? 400;
        const directions = {
          up: [0, -amount],
          down: [0, amount],
          left: [-amount, 0],
          right: [amount, 0],
        } as const;
        const [x, y] = directions[args.direction];
        return page.mouse.wheel(x, y);
      }
      case 'back':
        await page.goBack(navigation);
        return page.url();
      case 'forward':
        await page.goForward(navigation);
        return page.url();
      case 'reload':
        await page.reload(navigation);
        return page.url();
      case 'evaluate':
        return page.evaluate(args.script);
      case 'dialog': {
        const trigger = locator(manager, args.target);
        // Handle the dialog while click is still waiting for it to close.
        // Cancelling the listener on click failure prevents handling a later manual dialog.
        const subscription = new AbortController();
        const dialogSignal = signal
          ? AbortSignal.any([signal, subscription.signal])
          : subscription.signal;
        try {
          const [message] = await Promise.all([
            page
              .waitForEvent('dialog', {
                timeout: options.timeout,
                signal: dialogSignal,
              })
              .then(async (dialog) => {
                dialogSignal.throwIfAborted();
                if (args.action === 'accept') await dialog.accept(args.text);
                else await dialog.dismiss();
                return { type: dialog.type(), message: dialog.message() };
              }),
            trigger.click({ ...options, signal: dialogSignal }),
          ]);
          return message;
        } finally {
          subscription.abort();
        }
      }
    }
  };
}
