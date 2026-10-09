import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PreviewLoading } from './preview-loading';
import type { PreviewRendererProps } from './types';

const TextPreview = lazy(() => import('./text-preview'));

export default function HtmlPreview(props: PreviewRendererProps) {
  const { data, line } = props;
  const { t } = useTranslation();
  return (
    <Tabs
      key={`${data.path}:${line ?? ''}`}
      defaultValue={line ? 'source' : 'rendered'}
      className="h-full min-h-0 min-w-0 gap-0"
    >
      <div className="shrink-0 border-b px-3 py-2">
        <TabsList aria-label={t('files.previewMode')} className="h-8">
          <TabsTrigger value="rendered" className="text-xs">
            {t('files.renderedPreview')}
          </TabsTrigger>
          <TabsTrigger value="source" className="text-xs">
            {t('files.sourcePreview')}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="rendered" className="min-h-0 overflow-hidden">
        <iframe
          title={t('files.htmlPreview', { name: data.path })}
          srcDoc={data.text ?? ''}
          // Keep scripts isolated from the application's origin and storage.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="block size-full border-0 bg-white"
        />
      </TabsContent>
      <TabsContent value="source" className="min-h-0 min-w-0">
        <Suspense fallback={<PreviewLoading />}>
          <TextPreview {...props} />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}
