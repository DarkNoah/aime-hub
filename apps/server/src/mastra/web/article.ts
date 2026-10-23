import { readBrowserPage, readWebPage } from './page.js';
import {
  assertWechatResult,
  isWechatUrl,
  WechatArticleError,
} from './wechat.js';

let wechatQueue = Promise.resolve();

function validateArticle(
  url: string,
  result: { url: string; content: string },
) {
  assertWechatResult(url, result);
  const text = result.content.trim();
  if (
    text.length < 1500 &&
    (/^# (?:Just a moment|Security Verification|Attention Required|安全验证|人机验证|验证码)\b/i.test(
      text,
    ) ||
      /verify (?:that )?you are human|complete the (?:captcha|security check)|请完成(?:安全|人机)验证|请输入验证码|完成验证后即可继续访问/i.test(
        text,
      ))
  )
    throw new Error('ARTICLE_VERIFICATION_REQUIRED');
}

/** News archiving reads complete articles, independent of Agent tool settings. */
export async function readArticleContent(
  url: string,
  signal: AbortSignal,
  readers: {
    browser?: typeof readBrowserPage;
    direct?: typeof readWebPage;
  } = {},
) {
  const read = async () => {
    signal.throwIfAborted();
    let result;
    let reader = 'playwright';
    try {
      result = await (readers.browser ?? readBrowserPage)(
        url,
        AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
        30_000,
      );
      validateArticle(url, result);
    } catch (browserError) {
      signal.throwIfAborted();
      try {
        result = await (readers.direct ?? readWebPage)(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        validateArticle(url, result);
        reader = 'direct';
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof WechatArticleError) throw error;
        if (browserError instanceof WechatArticleError) throw browserError;
        if (
          browserError instanceof Error &&
          browserError.message === 'ARTICLE_VERIFICATION_REQUIRED'
        )
          throw browserError;
        if (
          (error instanceof Error &&
            /timeout|abort/i.test(error.name + error.message)) ||
          (browserError instanceof Error &&
            /timeout/i.test(browserError.name + browserError.message))
        )
          throw new Error('ARTICLE_TIMEOUT');
        throw error;
      }
    }
    // No maxChars/slice: never persist a partially read article as complete.
    return {
      ...result,
      provider: reader,
      fallback: reader === 'direct',
      ok: true,
    };
  };
  if (!isWechatUrl(url)) return read();
  // Serialize this host across all callers without sharing browser login state.
  const task = wechatQueue.then(read);
  wechatQueue = task.then(
    () => {},
    () => {},
  );
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
