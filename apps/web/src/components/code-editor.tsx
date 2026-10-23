import { lazy, memo, Suspense, useState } from 'react';
import { Code2, Copy, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

const CodeBlockContent = lazy(() =>
  import('./ai-elements/code-block').then((m) => ({
    default: m.CodeBlockContent,
  })),
);

export const CodeEditor = memo(function CodeEditor({
  value,
  onChange,
  onSave,
  readOnly = false,
  language = 'python',
  filename = 'strategy.py',
  label = 'Python 策略脚本',
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  language?: 'python' | 'json';
  filename?: string;
  label?: string;
}) {
  const [mode, setMode] = useState('preview');
  return (
    <Tabs
      value={readOnly ? 'preview' : mode}
      onValueChange={setMode}
      className="min-w-0 gap-0 overflow-hidden rounded-md border"
      dir="ltr"
    >
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
        <span className="font-mono text-xs">{filename}</span>
        <div className="flex items-center gap-1">
          {!readOnly && (
            <TabsList aria-label={`${label}显示方式`} className="h-8">
              <TabsTrigger value="preview" className="text-xs">
                <Eye className="size-3.5" />
                高亮预览
              </TabsTrigger>
              <TabsTrigger value="edit" className="text-xs">
                <Code2 className="size-3.5" />
                编辑
              </TabsTrigger>
            </TabsList>
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`复制 ${filename}`}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                toast.success('代码已复制');
              } catch {
                toast.error('复制失败');
              }
            }}
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
      </div>
      <TabsContent value="preview" className="min-w-0">
        <ScrollArea
          className="h-[460px]"
          viewportProps={{ tabIndex: 0, 'aria-label': `${label}高亮预览` }}
        >
          <div className="[&>div]:overflow-visible [&_pre]:text-xs">
            <Suspense
              fallback={<pre className="p-4 font-mono text-xs">{value}</pre>}
            >
              <CodeBlockContent
                code={value}
                language={language}
                showLineNumbers
              />
            </Suspense>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="edit" className="min-w-0">
        <ScrollArea
          className="h-[460px]"
          viewportProps={{ className: '[&>div]:block!' }}
        >
          <Textarea
            aria-label={label}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="min-h-[460px] resize-none rounded-none border-0 font-mono text-xs leading-6 shadow-none"
            onKeyDown={(e) => {
              if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSave?.();
              }
              if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                const target = e.currentTarget;
                const from = target.selectionStart,
                  to = target.selectionEnd;
                onChange(value.slice(0, from) + '    ' + value.slice(to));
                requestAnimationFrame(() =>
                  target.setSelectionRange(from + 4, from + 4),
                );
              }
            }}
          />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
});
