import { useContext, type ComponentProps } from 'react';
import type { ExtraProps } from 'streamdown';
import { WorkspaceFileThreadContext } from '@/components/file-manager/context';
import { WorkspaceAttachment } from '@/components/file-manager/workspace-attachment';
import { PreviewImage } from '@/components/image-viewer/preview-image';
import { cn } from '@/lib/utils';
import {
  getWorkspaceFileTarget,
  isEncodedWorkspaceFileLink,
} from './markdown-file-link';

type MarkdownImageProps = ComponentProps<'img'> & ExtraProps;

export function MarkdownImage({
  src,
  alt = '',
  className,
  title,
}: MarkdownImageProps) {
  const threadId = useContext(WorkspaceFileThreadContext);
  if (typeof src !== 'string' || !src) return <span>{alt}</span>;
  if (!isEncodedWorkspaceFileLink(src)) {
    return (
      <PreviewImage
        inline
        src={src}
        alt={alt}
        title={title}
        referrerPolicy="no-referrer"
        containerClassName="mx-0 my-2 grid"
        className={cn(
          'max-h-[60vh] max-w-full rounded-lg object-contain',
          className,
        )}
      />
    );
  }
  const target = getWorkspaceFileTarget(src);
  return target ? (
    <WorkspaceAttachment
      threadId={threadId}
      file={{
        path: target.path,
        name: target.path.split('/').at(-1) || target.path,
        label: alt,
      }}
      title={title}
      className={cn('my-2', className)}
    />
  ) : (
    <span>{alt}</span>
  );
}
