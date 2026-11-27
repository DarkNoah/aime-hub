import { memo, useContext, type ComponentProps } from 'react';
import { ExternalLink, FileText, Folder } from 'lucide-react';
import type { ExtraProps } from 'streamdown';
import { Badge } from '@/components/ui/badge';
import { BrowserLink } from '@/components/browser/browser-link';
import {
  WorkspaceFileThreadContext,
  useWorkspaceFile,
} from '@/components/file-manager/context';
import { WorkspaceAttachment } from '@/components/file-manager/workspace-attachment';
import { cn } from '@/lib/utils';
import {
  getWorkspaceFileTarget,
  isEncodedWorkspaceFileLink,
  isWorkspaceDirectoryLink,
} from './markdown-file-link';

type MarkdownLinkProps = ComponentProps<'a'> & ExtraProps;
const badgeClassName = 'mx-1 max-w-full align-baseline whitespace-nowrap';
const badgeTextClassName = 'min-w-0 max-w-[24ch] truncate';

function linkLabel(node: NonNullable<ExtraProps['node']>): string {
  return node.children
    .map((child) => {
      if (child.type === 'text') return child.value;
      if (child.type !== 'element') return '';
      return typeof child.properties.alt === 'string'
        ? child.properties.alt
        : linkLabel(child);
    })
    .join('');
}

function getWebUrl(href?: string): string | undefined {
  if (!href) return undefined;

  try {
    const url = new URL(href);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export const MarkdownLink = memo(
  ({
    children,
    className,
    href,
    node,
    onAuxClick,
    onClick,
    ...props
  }: MarkdownLinkProps) => {
    const openFile = useWorkspaceFile();
    const threadId = useContext(WorkspaceFileThreadContext);

    if (isEncodedWorkspaceFileLink(href)) {
      const file = getWorkspaceFileTarget(href);
      if (!file) return <span>{children}</span>;
      const directory = isWorkspaceDirectoryLink(href);
      if (
        threadId &&
        !file.path.startsWith('/') &&
        !directory &&
        file.line === undefined
      ) {
        return (
          <WorkspaceAttachment
            threadId={threadId}
            file={{
              path: file.path,
              name: file.path.split('/').at(-1) || file.path,
              label: node
                ? linkLabel(node).trim()
                : typeof children === 'string'
                  ? children.trim()
                  : undefined,
            }}
            title={props.title}
            className={cn('my-2', className)}
          />
        );
      }
      if (!openFile) return <span>{children}</span>;

      return (
        <Badge
          asChild
          className={cn(className, badgeClassName)}
          variant="secondary"
        >
          <a
            {...props}
            href="#"
            title={
              props.title ?? `${file.path}${file.line ? `:${file.line}` : ''}`
            }
            onAuxClick={(event) => {
              onAuxClick?.(event);
              if (!event.defaultPrevented && event.button === 1)
                event.preventDefault();
            }}
            onClick={(event) => {
              onClick?.(event);
              if (!event.defaultPrevented) {
                event.preventDefault();
                openFile(
                  file.path,
                  directory ? 'directory' : 'file',
                  file.line,
                );
              }
            }}
          >
            {directory ? (
              <Folder className="size-3 shrink-0" aria-hidden="true" />
            ) : (
              <FileText className="size-3 shrink-0" aria-hidden="true" />
            )}
            <span className={badgeTextClassName}>{children}</span>
          </a>
        </Badge>
      );
    }

    const webUrl = getWebUrl(href);
    if (href && /^https?:/i.test(href) && !webUrl) {
      return <span>{children}</span>;
    }

    if (webUrl) {
      return (
        <Badge
          asChild
          className={cn(className, badgeClassName)}
          variant="outline"
        >
          <BrowserLink
            {...props}
            href={webUrl}
            onClick={onClick}
            rel="noopener noreferrer"
            target="_blank"
            title={props.title ?? webUrl}
          >
            <span className={badgeTextClassName}>{children}</span>
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </BrowserLink>
        </Badge>
      );
    }

    if (href?.toLowerCase() === 'streamdown:incomplete-link') {
      return (
        <span className={className} data-incomplete="true">
          {children}
        </span>
      );
    }

    return (
      <a
        {...props}
        className={cn(
          'font-medium text-primary underline underline-offset-4',
          className,
        )}
        href={href}
        onAuxClick={onAuxClick}
        onClick={onClick}
      >
        {children}
      </a>
    );
  },
);

MarkdownLink.displayName = 'MarkdownLink';
