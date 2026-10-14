import { lazy, memo, Suspense } from 'react';
import { Code2, Copy, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CustomRendererProps } from 'streamdown';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const CodeBlockContent = lazy(() =>
  import('./code-block').then((module) => ({
    default: module.CodeBlockContent,
  })),
);

export const HtmlCodeBlock = memo(function HtmlCodeBlock({
  code,
  isIncomplete,
}: CustomRendererProps) {
  const { t } = useTranslation();

  async function copySource() {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t('chat.html.copied'));
    } catch {
      toast.error(t('chat.copyFailed'));
    }
  }

  return (
    <Tabs
      defaultValue="preview"
      className="not-prose min-w-0 gap-0 overflow-hidden rounded-lg border bg-background"
      data-streamdown="html-code-block"
      dir="ltr"
    >
      <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground">HTML</span>
        <div className="flex items-center gap-1">
          <TabsList aria-label={t('chat.html.mode')} className="h-8">
            <TabsTrigger value="preview" className="text-xs">
              <Eye className="size-3.5" aria-hidden="true" />
              {t('chat.html.preview')}
            </TabsTrigger>
            <TabsTrigger value="source" className="text-xs">
              <Code2 className="size-3.5" aria-hidden="true" />
              {t('files.sourcePreview')}
            </TabsTrigger>
          </TabsList>
          <Button
            variant="ghost"
            size="icon-sm"
            title={t('chat.html.copy')}
            aria-label={t('chat.html.copy')}
            onClick={() => void copySource()}
          >
            <Copy className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <TabsContent value="preview" className="min-w-0 overflow-hidden">
        <iframe
          key={isIncomplete ? 'streaming' : 'complete'}
          title={t('chat.html.title')}
          srcDoc={code}
          // Run scripts only after the fence closes, isolated from app storage.
          sandbox={isIncomplete ? '' : 'allow-scripts'}
          referrerPolicy="no-referrer"
          className="block h-96 w-full border-0 bg-white"
        />
      </TabsContent>
      <TabsContent value="source" className="min-w-0">
        <ScrollArea
          className="h-96"
          viewportProps={{
            tabIndex: 0,
            'aria-label': t('files.sourcePreview'),
          }}
        >
          <div className="[&>div]:overflow-visible">
            <Suspense
              fallback={<pre className="m-0 p-4 font-mono text-sm">{code}</pre>}
            >
              <CodeBlockContent code={code} language="html" showLineNumbers />
            </Suspense>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
});
