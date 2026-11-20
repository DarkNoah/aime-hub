import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { getSandboxFileLink } from '../ai-elements/markdown-file-link.js';

type MessageLink = {
  start: number;
  end: number;
  href: string;
  label: string;
  title?: string;
};

export function getUserMessageLinks(text: string): MessageLink[] {
  const links: MessageLink[] = [];
  if (!/sandbox:\//i.test(text)) return links;

  // Source offsets let the surrounding message keep its original formatting.
  function visit(nodes: ReturnType<typeof fromMarkdown>['children']) {
    for (const node of nodes) {
      if (node.type === 'link') {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const href = getSandboxFileLink(node.url);
        if (
          href &&
          start !== undefined &&
          end !== undefined &&
          text[start] === '['
        ) {
          links.push({
            start,
            end,
            href,
            label: toString(node),
            title: node.title ?? undefined,
          });
        }
      } else if ('children' in node) {
        visit(node.children);
      }
    }
  }

  visit(fromMarkdown(text).children);
  return links;
}
