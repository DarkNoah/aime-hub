import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export default function TextEditor({
  text,
  line,
  disabled,
  wrap,
  onChange,
}: {
  text: string;
  line?: number;
  disabled: boolean;
  wrap: boolean;
  onChange: (text: string) => void;
}) {
  const { t } = useTranslation();
  const editor = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const lines = text.split('\n');
  useLayoutEffect(() => {
    const input = editor.current;
    const container = viewport.current;
    if (!input || !container) return;
    function resize() {
      if (!input || !container) return;
      input.style.height = '0px';
      input.style.height = `${Math.max(input.scrollHeight, container.clientHeight - 24)}px`;
    }
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [text, wrap]);
  useEffect(() => {
    const input = editor.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    if (line) {
      const offset = input.value
        .split('\n')
        .slice(0, line - 1)
        .reduce((length, value) => length + value.length + 1, 0);
      input.setSelectionRange(offset, offset);
      viewport.current?.scrollTo({ top: Math.max(0, (line - 3) * 24) });
    }
  }, [line]);
  return (
    <ScrollArea
      className="h-full min-h-0 bg-card"
      viewportProps={{ ref: viewport }}
    >
      <div
        className="flex min-h-full min-w-full py-3 font-mono text-xs leading-6"
        style={{
          width: wrap
            ? '100%'
            : `${lines.reduce((width, value) => Math.max(width, value.replace(/\t/g, '  ').length * 2), 1) + 10}ch`,
        }}
      >
        {!wrap && (
          <div
            aria-hidden="true"
            className="sticky left-0 w-14 shrink-0 select-none whitespace-pre bg-card pr-4 text-right text-muted-foreground"
          >
            {lines.map((_, index) => index + 1).join('\n')}
          </div>
        )}
        <Textarea
          ref={editor}
          aria-label={t('files.textEditor')}
          value={text.replace(/\r\n/g, '\n')}
          readOnly={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap={wrap ? 'soft' : 'off'}
          rows={Math.max(1, lines.length)}
          className={cn(
            'min-h-full min-w-0 flex-1 resize-none overflow-hidden rounded-none border-0 bg-transparent! p-0 pr-5 font-mono text-xs leading-6 shadow-none field-sizing-fixed focus-visible:ring-0 md:text-xs',
            wrap && 'pl-3 whitespace-pre-wrap [overflow-wrap:anywhere]',
          )}
          style={{ tabSize: 2 }}
          onChange={(event) => {
            // Native textareas normalize newlines; retain Windows files' line endings.
            const value = event.target.value;
            onChange(
              text.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value,
            );
          }}
        />
      </div>
      {!wrap && <ScrollBar orientation="horizontal" />}
    </ScrollArea>
  );
}
