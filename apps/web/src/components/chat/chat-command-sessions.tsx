import type { ThreadCommandSession } from '@aime/shared/threads';
import { useRef, useState } from 'react';
import { LoaderCircle, Square, TerminalSquare, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { chatErrorKey } from './api';

export function ChatCommandSessions({
  commands,
  disabled,
  onCleanup,
}: {
  commands: ThreadCommandSession[];
  disabled: boolean;
  onCleanup: (sessionId: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const pending = useRef(new Set<number>());
  const [cleaning, setCleaning] = useState<Set<number>>(new Set());

  async function cleanup(sessionId: number) {
    if (disabled || pending.current.has(sessionId)) return;
    pending.current.add(sessionId);
    setCleaning(new Set(pending.current));
    try {
      await onCleanup(sessionId);
      toast.success(t('chat.commandSessions.cleaned'));
    } catch (error) {
      const key = chatErrorKey(error);
      toast.error(
        t(key === 'chat.errors.failed' ? 'chat.commandSessions.failed' : key),
      );
    } finally {
      pending.current.delete(sessionId);
      setCleaning(new Set(pending.current));
    }
  }

  return (
    <section
      aria-label={t('chat.commandSessions.title')}
      className="border-t px-3 py-2"
    >
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium">
        <TerminalSquare
          className="size-3.5 text-muted-foreground"
          aria-hidden
        />
        {t('chat.commandSessions.title')}
      </h3>
      <ul className="divide-y">
        {commands.map((command) => {
          const exited = command.status === 'exited';
          const busy =
            cleaning.has(command.sessionId) || command.status === 'stopping';
          const action = t(
            exited
              ? 'chat.commandSessions.release'
              : 'chat.commandSessions.stop',
          );
          return (
            <li key={command.sessionId} className="min-w-0 space-y-1.5 py-2">
              <p
                className="line-clamp-2 whitespace-pre-wrap break-all font-mono text-xs"
                title={command.cmd}
              >
                {command.cmd}
              </p>
              <p
                className="truncate text-[11px] text-muted-foreground"
                title={command.workdir}
              >
                {command.workdir}
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
                <span>
                  {t('chat.commandSessions.session', { id: command.sessionId })}
                </span>
                {command.pid && <span>PID {command.pid}</span>}
                {command.tty && <span>PTY</span>}
                {exited && command.exitCode !== undefined && (
                  <span>
                    {t('chat.command.exitCode', { value: command.exitCode })}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge
                  variant={
                    exited && command.exitCode !== 0
                      ? 'destructive'
                      : 'secondary'
                  }
                  className="text-[10px]"
                >
                  {t(`chat.commandSessions.status.${command.status}`)}
                </Badge>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 text-xs text-muted-foreground hover:text-destructive"
                  disabled={disabled || busy}
                  aria-label={`${action} · ${command.sessionId}`}
                  onClick={() => void cleanup(command.sessionId)}
                >
                  {busy ? (
                    <LoaderCircle
                      className="size-3 motion-safe:animate-spin"
                      aria-hidden
                    />
                  ) : exited ? (
                    <Trash2 className="size-3" aria-hidden />
                  ) : (
                    <Square className="size-3" aria-hidden />
                  )}
                  {action}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        {t('chat.commandSessions.hint')}
      </p>
    </section>
  );
}
