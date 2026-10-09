import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import type { WebFetchResult } from './web-fetch.js';

export async function extractWebContent(
  html: string,
  url: string,
): Promise<WebFetchResult> {
  const { document } = parseHTML(html);
  // linkedom does not execute scripts or load resources. Keep metadata for Defuddle,
  // and normalize relative links against the final URL before conversion.
  let base = url;
  const declaredBase = document
    .querySelector('base[href]')
    ?.getAttribute('href');
  try {
    const candidate = new URL(declaredBase ?? url, url);
    if (['http:', 'https:'].includes(candidate.protocol)) base = candidate.href;
  } catch {
    /* Ignore malformed base elements. */
  }
  for (const node of document.querySelectorAll('[href], [src]')) {
    for (const attribute of ['href', 'src']) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      try {
        const target = new URL(value, base);
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
  const article = await Defuddle(document as unknown as Document, url, {
    markdown: true,
    // All network access stays in the bounded, cancellable request/browser stages.
    useAsync: false,
  });
  const markdown = article.content.trim();
  if (!markdown) throw new Error('No readable page content');
  const title = article.title?.trim();
  return {
    content:
      title && !markdown.startsWith(`# ${title}\n`) && markdown !== `# ${title}`
        ? `# ${title}\n\n${markdown}`
        : markdown,
    title,
    url,
    contentType: 'text/markdown',
  };
}
