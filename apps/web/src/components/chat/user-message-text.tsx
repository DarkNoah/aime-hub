import { memo, type ReactNode } from 'react';
import { MarkdownImage } from '@/components/ai-elements/markdown-image';
import { MarkdownLink } from '@/components/ai-elements/markdown-link';
import {
  WorkspaceFileThreadContext,
  useWorkspaceFile,
} from '@/components/file-manager/context';
import { getUserMessageLinks } from './user-message-links';

export const UserMessageText = memo(function UserMessageText({
  text,
  threadId,
}: {
  text: string;
  threadId?: string;
}) {
  const openFile = useWorkspaceFile();
  if (!openFile && !threadId) return text;
  const links = getUserMessageLinks(text, !!threadId);
  if (!links.length) return text;

  const parts: ReactNode[] = [];
  let offset = 0;
  for (const link of links) {
    parts.push(text.slice(offset, link.start));
    parts.push(
      link.image ? (
        <MarkdownImage
          key={link.start}
          src={link.href}
          alt={link.label}
          title={link.title}
        />
      ) : (
        <MarkdownLink key={link.start} href={link.href} title={link.title}>
          {link.label}
        </MarkdownLink>
      ),
    );
    offset = link.end;
  }
  parts.push(text.slice(offset));
  return (
    <WorkspaceFileThreadContext.Provider value={threadId}>
      {parts}
    </WorkspaceFileThreadContext.Provider>
  );
});
