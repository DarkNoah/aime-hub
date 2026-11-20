import { createContext, useContext, useMemo, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { defaultRehypePlugins } from 'streamdown';
import {
  rehypePreviewFileLinks,
  resolvePreviewFileLink,
} from '@/components/ai-elements/markdown-file-link';
import { MarkdownImage } from '@/components/ai-elements/markdown-image';
import { MarkdownContent } from '@/components/markdown-content';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PreviewLinkNavigation, PreviewRendererProps } from './types';

const DocumentContext = createContext<PreviewLinkNavigation & { path: string }>(
  {
    path: '',
  },
);
const linkClassName = 'font-medium text-primary underline underline-offset-4';
const rehypePlugins = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  rehypePreviewFileLinks,
  defaultRehypePlugins.harden,
];

function RelativeLink({ href, title, children }: ComponentProps<'a'>) {
  const { path, getFileUrl, onOpenLink } = useContext(DocumentContext);
  const target = href && resolvePreviewFileLink(path, href);
  if (!target) return <span>{children}</span>;
  const fileUrl =
    target.kind === 'file' ? getFileUrl?.(target.path) : undefined;
  if (!onOpenLink && !fileUrl) return <span>{children}</span>;
  return (
    <a
      className={linkClassName}
      href={fileUrl ?? '#'}
      title={title ?? href}
      onClick={(event) => {
        if (
          !onOpenLink ||
          (fileUrl &&
            (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey))
        )
          return;
        event.preventDefault();
        onOpenLink(target.path, target.kind, target.line);
      }}
    >
      {children}
    </a>
  );
}

function DocumentLink({ href, title, children }: ComponentProps<'a'>) {
  const external = href && /^https?:\/\//i.test(href);
  return (
    <a
      className={linkClassName}
      href={href}
      title={title}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
    >
      {children}
    </a>
  );
}

const components = {
  a: DocumentLink,
  img: MarkdownImage,
  'preview-file-link': RelativeLink,
};

export default function MarkdownPreview({
  data,
  getFileUrl,
  onOpenLink,
}: PreviewRendererProps) {
  const { t } = useTranslation();
  const navigation = useMemo(
    () => ({ path: data.path, getFileUrl, onOpenLink }),
    [data.path, getFileUrl, onOpenLink],
  );
  return (
    <ScrollArea
      className="h-full min-h-0 bg-card"
      viewportProps={{
        tabIndex: 0,
        'aria-label': t('files.markdownPreview', { name: data.path }),
      }}
    >
      <article className="mx-auto max-w-[75ch] min-w-0 px-5 py-6 text-sm leading-7 [overflow-wrap:anywhere]">
        <DocumentContext.Provider value={navigation}>
          <MarkdownContent
            mode="static"
            components={components}
            rehypePlugins={rehypePlugins}
          >
            {data.text ?? ''}
          </MarkdownContent>
        </DocumentContext.Provider>
      </article>
    </ScrollArea>
  );
}
