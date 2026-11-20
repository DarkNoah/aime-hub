import { memo, type ReactNode } from 'react';
import { MarkdownLink } from '@/components/ai-elements/markdown-link';
import { useWorkspaceFile } from '@/components/file-manager/context';
import { getUserMessageLinks } from './user-message-links';

export const UserMessageText = memo(function UserMessageText({
  text,
}: {
  text: string;
}) {
  const openFile = useWorkspaceFile();
  if (!openFile) return text;
  const links = getUserMessageLinks(text);
  if (!links.length) return text;

  const parts: ReactNode[] = [];
  let offset = 0;
  for (const link of links) {
    parts.push(text.slice(offset, link.start));
    parts.push(
      <MarkdownLink key={link.start} href={link.href} title={link.title}>
        {link.label}
      </MarkdownLink>,
    );
    offset = link.end;
  }
  parts.push(text.slice(offset));
  return parts;
});
