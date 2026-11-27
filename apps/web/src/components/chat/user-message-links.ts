import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import {
  getMessageWorkspaceFileLink,
  getSandboxFileLink,
} from '../ai-elements/markdown-file-link.js';

type MessageLink = {
  start: number;
  end: number;
  href: string;
  label: string;
  image?: boolean;
  title?: string;
};

export function getUserMessageLinks(
  text: string,
  workspaceAttachments = false,
): MessageLink[] {
  const links: MessageLink[] = [];
  if (!text.includes('](')) return links;
  if (!workspaceAttachments && !/sandbox:\//i.test(text)) return links;

  // Source offsets let the surrounding message keep its original formatting.
  function visit(nodes: ReturnType<typeof fromMarkdown>['children']) {
    for (const node of nodes) {
      if (
        node.type === 'link' ||
        (workspaceAttachments && node.type === 'image')
      ) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const image = node.type === 'image';
        const href =
          workspaceAttachments && !node.url.startsWith('/')
            ? getMessageWorkspaceFileLink(node.url)
            : getSandboxFileLink(node.url);
        if (
          href &&
          start !== undefined &&
          end !== undefined &&
          text[start] === (image ? '!' : '[')
        ) {
          links.push({
            start,
            end,
            href,
            label: image ? (node.alt ?? '') : toString(node),
            ...(image ? { image } : {}),
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
