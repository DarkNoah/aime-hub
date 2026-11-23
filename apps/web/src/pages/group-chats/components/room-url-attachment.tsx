import { useState } from 'react';
import { ExternalLink, FileText, Link2 } from 'lucide-react';
import { fileMediaTypes } from '@aime/shared/files';
import {
  parseGroupChatFileUrl,
  type GroupChatUrlFile,
} from '@aime/shared/group-chats';
import { AudioClip } from '@/components/audio/audio-clip';
import { BrowserLink } from '@/components/browser/browser-link';
import { PreviewImage } from '@/components/image-viewer/preview-image';

function mimeFromFilename(filename: string) {
  const extension = /\.[^./]+$/.exec(filename)?.[0].toLowerCase();
  return extension ? fileMediaTypes[extension]?.[1] : undefined;
}

export function RoomUrlAttachment({ file }: { file: GroupChatUrlFile }) {
  const [failed, setFailed] = useState(false);
  const url = parseGroupChatFileUrl(file.url);
  if (!url) return <span className="text-sm">{file.name}</span>;

  const mime =
    file.mimeType?.split(';')[0].trim().toLowerCase() ||
    mimeFromFilename(url.pathname) ||
    mimeFromFilename(file.name);
  const pdf = mime === 'application/pdf';
  const Icon = pdf ? FileText : Link2;
  return (
    <div className="w-fit min-w-0 max-w-full overflow-hidden rounded-lg border bg-card">
      {!failed && mime?.startsWith('image/') && (
        <PreviewImage
          src={url.href}
          alt={file.name}
          referrerPolicy="no-referrer"
          className="max-h-80 rounded-none"
          onError={() => setFailed(true)}
        />
      )}
      {!failed && mime?.startsWith('video/') && (
        <video
          src={url.href}
          controls
          playsInline
          preload="none"
          aria-label={file.name}
          className="block max-h-80 max-w-full"
          onError={() => setFailed(true)}
        />
      )}
      {mime?.startsWith('audio/') && (
        <AudioClip
          compact
          src={url.href}
          filename={file.name}
          mediaType={mime}
          className="p-2"
        />
      )}
      <BrowserLink
        href={url.href}
        target="_blank"
        rel="noopener noreferrer"
        title={url.href}
        className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted/50 focus-visible:outline-offset-[-2px]"
      >
        <Icon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="grid min-w-0 flex-1">
          <span className="truncate font-medium">{file.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {pdf && 'PDF · '}
            {url.host}
          </span>
        </span>
        <ExternalLink
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </BrowserLink>
    </div>
  );
}
