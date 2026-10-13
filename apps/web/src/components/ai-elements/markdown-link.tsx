import { memo, type ComponentProps } from 'react';
import { ExternalLink, FileText, Folder } from 'lucide-react';
import type { ExtraProps } from 'streamdown';
import { Badge } from '@/components/ui/badge';
import { useWorkspaceFile } from '@/components/file-manager/context';
import { cn } from '@/lib/utils';
import {
  getWorkspaceFilePath,
  isWorkspaceDirectoryLink,
} from './markdown-file-link';

type MarkdownLinkProps = ComponentProps<'a'> & ExtraProps;
const badgeClassName = 'mx-1 max-w-full align-baseline whitespace-nowrap';
const badgeTextClassName = 'min-w-0 max-w-[24ch] truncate';

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
    node: _node,
    onAuxClick,
    onClick,
    ...props
  }: MarkdownLinkProps) => {
    const openFile = useWorkspaceFile();
    const filePath = getWorkspaceFilePath(href);
    const webUrl = getWebUrl(href);

    if (href?.toLowerCase().startsWith('streamdown:workspace-file/')) {
      if (!filePath || !openFile) return <span>{children}</span>;
      const directory = isWorkspaceDirectoryLink(href);

      return (
        <Badge
          asChild
          className={cn(className, badgeClassName)}
          variant="secondary"
        >
          <a
            {...props}
            href="#"
            title={props.title ?? filePath}
            onAuxClick={(event) => {
              onAuxClick?.(event);
              if (!event.defaultPrevented && event.button === 1)
                event.preventDefault();
            }}
            onClick={(event) => {
              onClick?.(event);
              if (!event.defaultPrevented) {
                event.preventDefault();
                openFile(filePath, directory ? 'directory' : 'file');
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
          <a
            {...props}
            href={webUrl}
            rel="noopener noreferrer"
            target="_blank"
            title={props.title ?? webUrl}
          >
            <span className={badgeTextClassName}>{children}</span>
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </a>
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
