import { parseHTML } from 'linkedom';
import type { DefuddleOptions } from 'defuddle';

export type WechatErrorCode =
  | 'WECHAT_VERIFICATION_REQUIRED'
  | 'WECHAT_ARTICLE_UNAVAILABLE'
  | 'WECHAT_CONTENT_MISSING';
export class WechatArticleError extends Error {
  constructor(readonly code: WechatErrorCode) {
    super(code);
  }
}
export function isWechatUrl(value: string) {
  try {
    return new URL(value).hostname.toLowerCase() === 'mp.weixin.qq.com';
  } catch {
    return false;
  }
}
export function assertWechatUrl(url: string) {
  if (isWechatUrl(url) && /captcha|verify|wappoc/i.test(new URL(url).pathname))
    throw new WechatArticleError('WECHAT_VERIFICATION_REQUIRED');
}

// Read a JS string literal as data. Never evaluate page scripts or expressions.
function stringLiteral(source: string, start: number) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return;
  let value = '';
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === quote) return { value, end: i + 1 };
    if (char !== '\\') {
      value += char;
      continue;
    }
    const escaped = source[++i];
    if (escaped === undefined) return;
    if (escaped === 'x' || escaped === 'u') {
      const size = escaped === 'x' ? 2 : 4;
      const hex = source.slice(i + 1, i + 1 + size);
      if (!new RegExp(`^[a-fA-F0-9]{${size}}$`).test(hex)) return;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      i += size;
    } else if (escaped === '\n') {
      continue;
    } else if (escaped === '\r') {
      if (source[i + 1] === '\n') i++;
    } else {
      value +=
        (
          { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<
            string,
            string
          >
        )[escaped] ?? escaped;
    }
  }
}
function decodedField(document: Document, field: 'content' | 'title') {
  const pattern = new RegExp(
    `\\b(?:msg_)?${field}\\s*[:=]\\s*JsDecode\\(\\s*`,
    'g',
  );
  for (const script of document.querySelectorAll('script')) {
    const source = script.textContent ?? '';
    for (const match of source.matchAll(pattern)) {
      const literal = stringLiteral(source, match.index! + match[0].length);
      if (!literal || !/^\s*\)/.test(source.slice(literal.end))) continue;
      const entities: Record<string, string> = {
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&apos;': "'",
        '&amp;': '&',
      };
      return literal.value.replace(
        /&(?:lt|gt|quot|apos|amp|#39);/g,
        (entity) => entities[entity],
      );
    }
  }
}
function readable(element: Element) {
  return (
    (element.textContent?.replace(/\s/g, '').length ?? 0) >= 10 ||
    [...element.querySelectorAll('img')].some((image) =>
      /^https?:\/\//.test(
        image.getAttribute('data-src') ?? image.getAttribute('src') ?? '',
      ),
    )
  );
}

/** Returns a narrowly scoped document; Defuddle still sanitizes and converts it. */
export function prepareWechatArticle(html: string, url: string) {
  assertWechatUrl(url);
  const { document } = parseHTML(html);
  let content = document.querySelector('#js_content');
  let title =
    document.querySelector('#activity-name')?.textContent?.trim() ||
    document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute('content') ||
    '';
  if (!content || !readable(content as unknown as Element)) {
    // Current templates may embed escaped HTML before client-side hydration.
    const decoded = decodedField(document as unknown as Document, 'content');
    if (decoded) {
      content = document.createElement('div');
      content.id = 'js_content';
      content.innerHTML = decoded;
    }
    title ||= decodedField(document as unknown as Document, 'title') ?? '';
  }
  if (!content || !readable(content as unknown as Element)) {
    if (
      /环境异常|完成验证后即可继续访问|访问过于频繁|wappoc_appmsgcaptcha|captcha_verify|id=["'](?:captcha|verify)/i.test(
        html,
      )
    )
      throw new WechatArticleError('WECHAT_VERIFICATION_REQUIRED');
    if (
      /该内容已被发布者删除|此内容因违规无法查看|该内容已被多人投诉|链接已过期|仅关注后可查看/.test(
        document.body.textContent ?? '',
      )
    )
      throw new WechatArticleError('WECHAT_ARTICLE_UNAVAILABLE');
    throw new WechatArticleError('WECHAT_CONTENT_MISSING');
  }
  for (const node of content.querySelectorAll(
    'script,style,noscript,template,button,input,mp-common-profile,.code-snippet__line-index',
  ))
    node.remove();
  for (const image of content.querySelectorAll('img[data-src]')) {
    image.setAttribute('src', image.getAttribute('data-src')!);
    image.removeAttribute('data-src');
  }
  for (const pre of content.querySelectorAll('pre')) {
    const lines = [...pre.children].filter((node) => node.tagName === 'CODE');
    if (lines.length > 1) {
      const code = document.createElement('code');
      code.textContent = lines.map((line) => line.textContent).join('\n');
      code.className = lines[0].className;
      pre.replaceChildren(code);
    }
  }
  // Do not let general readability heuristics remove short Chinese paragraphs.
  const scoped = parseHTML(
    '<html><head><title></title></head><body></body></html>',
  ).document;
  scoped.querySelector('title')!.textContent = title;
  scoped.body.appendChild(content.cloneNode(true));
  const options: DefuddleOptions = {
    contentSelector: '#js_content',
    removeHiddenElements: false,
    removeLowScoring: false,
    removeSmallImages: false,
    removeExactSelectors: false,
    removePartialSelectors: false,
    removeContentPatterns: false,
  };
  return { document: scoped, options, title };
}

/** Providers returning Markdown must not pass through an interstitial or chrome. */
export function assertWechatResult(
  requestedUrl: string,
  result: { url: string; content: string },
) {
  if (!isWechatUrl(requestedUrl)) return;
  assertWechatUrl(result.url);
  const text = result.content.trim();
  if (
    text.length < 1500 &&
    /环境异常|完成验证后即可继续访问|Please complete.*verification|wappoc_appmsgcaptcha/i.test(
      text,
    )
  )
    throw new WechatArticleError('WECHAT_VERIFICATION_REQUIRED');
  const meaningful = text
    .replace(/^#{1,6} .*$/gm, '')
    .replace(
      /Weixin Official Accounts Platform|微信公众平台|轻点两下取消(?:赞|在看)|视频|小程序|在看|赞|Video|Mini Program|Like|Wow/gi,
      '',
    )
    .replace(/[\s\p{P}\p{S}]/gu, '');
  if (meaningful.length < 10 && !/!\[[^\]]*\]\(https?:\/\//.test(text))
    throw new WechatArticleError('WECHAT_CONTENT_MISSING');
}
