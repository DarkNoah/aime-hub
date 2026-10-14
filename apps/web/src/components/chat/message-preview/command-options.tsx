import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';

/** The same wait/output options apply to command execution and stdin polling. */
export function CommandOptions({
  input,
  command = false,
}: {
  input: Record<string, unknown>;
  command?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const number = (value: number) => value.toLocaleString(i18n.language);
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 text-xs leading-5 [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere]">
      {command && (
        <>
          <dt>{t('chat.command.cwd')}</dt>
          <dd className="font-mono">
            {typeof input.workdir === 'string'
              ? input.workdir
              : t('chat.command.defaultCwd')}
          </dd>
          <dt>{t('chat.command.shell')}</dt>
          <dd className="font-mono">
            {typeof input.shell === 'string'
              ? input.shell
              : t('chat.command.defaultShell')}
          </dd>
          <dt>{t('chat.command.mode')}</dt>
          <dd className="flex flex-wrap gap-1.5">
            <Badge variant="outline">
              {t(input.tty === true ? 'chat.command.pty' : 'chat.command.pipe')}
            </Badge>
            <Badge variant="outline">
              {t(
                input.login === false
                  ? 'chat.command.noLogin'
                  : 'chat.command.login',
              )}
            </Badge>
          </dd>
        </>
      )}
      <dt>{t('chat.command.wait')}</dt>
      <dd>
        {t('chat.command.milliseconds', {
          value: number(
            typeof input.yield_time_ms === 'number'
              ? input.yield_time_ms
              : 10000,
          ),
        })}
      </dd>
      <dt>{t('chat.command.outputBudget')}</dt>
      <dd>
        {t('chat.command.tokenCount', {
          value: number(
            typeof input.max_output_tokens === 'number'
              ? input.max_output_tokens
              : 10000,
          ),
        })}
      </dd>
    </dl>
  );
}
