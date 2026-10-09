import {
  Clock3,
  FolderOpen,
  ListEnd,
  Play,
  SquareTerminal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ai-elements/code-block';
import { ToolInput } from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';

export function CommandInput({ input }: { input: unknown }) {
  const { t } = useTranslation();
  if (
    !input ||
    typeof input !== 'object' ||
    !('command' in input) ||
    typeof input.command !== 'string'
  )
    return input === undefined ? null : <ToolInput input={input} />;

  const { command, description, cwd, timeout, tail, background, ...extra } =
    input as Record<string, unknown> & { command: string };
  const hasTimeout = typeof timeout === 'number' || typeof timeout === 'string';
  const hasTail = typeof tail === 'number' || typeof tail === 'string';

  return (
    <div className="min-w-0 space-y-3">
      {typeof description === 'string' && description && (
        <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
          {description}
        </p>
      )}
      <CodeBlock
        code={command}
        language="bash"
        className="[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
      >
        <CodeBlockHeader>
          <CodeBlockTitle>
            <SquareTerminal className="size-3.5" aria-hidden="true" />
            {t('chat.command.command')}
          </CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton
              className="size-7"
              aria-label={t('chat.command.copy')}
              title={t('chat.command.copy')}
              disabled={!command}
              onCopy={() => toast.success(t('chat.command.copied'))}
              onError={() => toast.error(t('chat.preview.copyFailed'))}
            />
          </CodeBlockActions>
        </CodeBlockHeader>
      </CodeBlock>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 text-xs leading-5">
        {typeof cwd === 'string' && cwd && (
          <>
            <dt className="flex items-center gap-2 text-muted-foreground">
              <FolderOpen className="size-3.5" aria-hidden="true" />
              {t('chat.command.cwd')}
            </dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{cwd}</dd>
          </>
        )}
        {hasTimeout && (
          <>
            <dt className="flex items-center gap-2 text-muted-foreground">
              <Clock3 className="size-3.5" aria-hidden="true" />
              {t('chat.command.timeout')}
            </dt>
            <dd>{t('chat.command.seconds', { value: timeout })}</dd>
          </>
        )}
        {hasTail && (
          <>
            <dt className="flex items-center gap-2 text-muted-foreground">
              <ListEnd className="size-3.5" aria-hidden="true" />
              {t('chat.command.outputLimit')}
            </dt>
            <dd>
              {Number(tail) === 0
                ? t('chat.command.unlimited')
                : t('chat.command.lastLines', { value: tail })}
            </dd>
          </>
        )}
        {typeof background === 'boolean' && (
          <>
            <dt className="flex items-center gap-2 text-muted-foreground">
              <Play className="size-3.5" aria-hidden="true" />
              {t('chat.command.mode')}
            </dt>
            <dd>
              <Badge variant="outline">
                {t(
                  background
                    ? 'chat.command.background'
                    : 'chat.command.foreground',
                )}
              </Badge>
            </dd>
          </>
        )}
      </dl>
      {Object.keys(extra).length > 0 && <ToolInput input={extra} />}
    </div>
  );
}
