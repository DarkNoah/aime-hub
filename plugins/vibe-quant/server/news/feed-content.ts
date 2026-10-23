import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';

/** The feed already selected the body: keep its paragraphs instead of scoring them. */
export async function feedContent(html: string, url: string) {
  const { document } = parseHTML('<html><head></head><body></body></html>');
  const root = document.createElement('div');
  root.id = 'feed-content';
  root.innerHTML = html;
  document.body.appendChild(root);
  root
    .querySelectorAll(
      'script,style,noscript,template,iframe,object,embed,form,button,input',
    )
    .forEach((node) => node.remove());
  for (const node of root.querySelectorAll('[href], [src], img[data-src]')) {
    if (node.localName === 'img' && node.hasAttribute('data-src')) {
      node.setAttribute('src', node.getAttribute('data-src')!);
      node.removeAttribute('data-src');
    }
    for (const attribute of ['href', 'src']) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      try {
        const target = new URL(value, url);
        if (
          ['http:', 'https:'].includes(target.protocol) &&
          !target.username &&
          !target.password
        )
          node.setAttribute(attribute, target.href);
        else node.removeAttribute(attribute);
      } catch {
        node.removeAttribute(attribute);
      }
    }
  }
  if (!root.textContent?.trim() && !root.querySelector('img[src]')) return '';
  const result = await Defuddle(document as unknown as Document, url, {
    markdown: true,
    useAsync: false,
    contentSelector: '#feed-content',
    removeHiddenElements: false,
    removeLowScoring: false,
    removeSmallImages: false,
    removeExactSelectors: false,
    removePartialSelectors: false,
    removeContentPatterns: false,
  });
  return result.content.trim();
}
