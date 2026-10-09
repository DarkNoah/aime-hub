import { isToolUIPart } from 'ai';
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
import { getStatusBadge } from '@/components/ai-elements/tool';
import { getToolName } from '../tool-renderers/registry';
import { CommandInput } from './command-input';
import type { PreviewPart } from './selection';

export function ExecuteCommandPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;

  const result =
    part.output === undefined
      ? ''
      : typeof part.output === 'string'
        ? part.output
        : JSON.stringify(part.output, null, 2);
  const output = [result, part.errorText].filter(Boolean).join('\n');

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-all text-sm font-medium">{getToolName(part)}</h3>
        {getStatusBadge(part.state)}
      </div>
      <CommandInput key={part.toolCallId} input={part.input} />
      <Terminal
        key={part.toolCallId}
        output={output}
        isStreaming={part.state === 'input-available'}
        autoScroll={false}
        className="min-w-0"
      >
        <TerminalHeader>
          <TerminalTitle>
            {t(part.errorText ? 'chat.toolError' : 'chat.toolResult')}
          </TerminalTitle>
          <TerminalActions>
            <TerminalCopyButton
              aria-label={t('chat.preview.copyOutput')}
              title={t('chat.preview.copyOutput')}
              disabled={!output}
              onCopy={() => toast.success(t('chat.preview.outputCopied'))}
              onError={() => toast.error(t('chat.preview.copyFailed'))}
            />
          </TerminalActions>
        </TerminalHeader>
        {/* The preview panel's ScrollArea owns scrolling. */}
        <TerminalContent className="max-h-none overflow-visible text-xs [&_pre]:[overflow-wrap:anywhere]" />
      </Terminal>
    </div>
  );
}
