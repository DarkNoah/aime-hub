import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalTitle,
} from '@/components/ai-elements/terminal';

export function CommandTerminal({
  output,
  title,
  copyLabel,
  copiedLabel,
  pending = false,
  empty,
  children,
}: {
  output: string;
  title: string;
  copyLabel?: string;
  copiedLabel?: string;
  pending?: boolean;
  empty?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const copy = copyLabel ?? t('chat.preview.copyOutput');
  return (
    <Terminal
      output={output}
      isStreaming={pending}
      autoScroll={false}
      className="min-w-0 [&_.animate-pulse]:motion-reduce:animate-none"
    >
      <TerminalHeader className="gap-2">
        <TerminalTitle className="min-w-0 text-xs [&>svg]:shrink-0">
          {title}
        </TerminalTitle>
        <TerminalActions>
          <TerminalCopyButton
            aria-label={copy}
            title={copy}
            disabled={!output}
            onCopy={() =>
              toast.success(copiedLabel ?? t('chat.preview.outputCopied'))
            }
            onError={() => toast.error(t('chat.preview.copyFailed'))}
          />
        </TerminalActions>
      </TerminalHeader>
      {/* ChatMessagePreview's ScrollArea owns scrolling for the entire panel. */}
      <TerminalContent className="max-h-none overflow-visible text-xs [&_pre]:[overflow-wrap:anywhere]">
        {children ??
          (!output && empty ? (
            <p
              role="status"
              className="font-sans text-xs leading-6 text-zinc-400"
            >
              {empty}
            </p>
          ) : undefined)}
      </TerminalContent>
    </Terminal>
  );
}
