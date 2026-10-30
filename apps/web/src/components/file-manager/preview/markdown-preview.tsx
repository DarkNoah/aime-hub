import { useTranslation } from 'react-i18next';
import { MarkdownContent } from '@/components/markdown-content';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PreviewRendererProps } from './types';

export default function MarkdownPreview({ data }: PreviewRendererProps) {
  const { t } = useTranslation();
  return (
    <ScrollArea
      className="h-full min-h-0 bg-card"
      viewportProps={{
        tabIndex: 0,
        'aria-label': t('files.markdownPreview', { name: data.path }),
      }}
    >
      <article className="mx-auto max-w-[75ch] min-w-0 px-5 py-6 text-sm leading-7 [overflow-wrap:anywhere]">
        <MarkdownContent mode="static" renderEnhancedLinks={false}>
          {data.text ?? ''}
        </MarkdownContent>
      </article>
    </ScrollArea>
  );
}
