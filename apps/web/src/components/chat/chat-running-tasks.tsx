import type {
  ThreadBackgroundTask,
  ThreadCommandSession,
} from '@aime/shared/threads';
import { useRef, useState } from 'react';
import {
  AlertCircle,
  LoaderCircle,
  Square,
  TerminalSquare,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { chatErrorKey } from './api';
import { ChatCommandSessions } from './chat-command-sessions';

const noCommands: ThreadCommandSession[] = [];

export function ChatRunningTasks({
  tasks,
  commands = noCommands,
  unavailable = false,
  disabled = false,
  onStop,
  onCleanup,
}: {
  tasks: ThreadBackgroundTask[];
  commands?: ThreadCommandSession[];
  unavailable?: boolean;
  disabled?: boolean;
  onStop: (taskId: string) => Promise<void>;
  onCleanup?: (sessionId: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const pending = useRef(new Set<string>());
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const running = tasks.filter((task) => task.status === 'running');
  const active =
    running.length +
    commands.filter((command) => command.status !== 'exited').length;
  const retained = commands.filter(
    (command) => command.status === 'exited',
  ).length;
  const count = running.length + commands.length;
  const description = unavailable
    ? t('chat.backgroundTasksUnavailable')
    : commands.length
      ? t('chat.commandSessions.summary', { running: active, retained })
      : t('chat.backgroundTasksRunning', { count: running.length });

  async function stop(taskId: string) {
    if (disabled || pending.current.has(taskId)) return;
    pending.current.add(taskId);
    setStopping(new Set(pending.current));
    try {
      await onStop(taskId);
      toast.success(t('chat.backgroundTaskStopped'));
    } catch (error) {
      const key = chatErrorKey(error);
      toast.error(
        t(key === 'chat.errors.failed' ? 'chat.backgroundTaskStopFailed' : key),
      );
    } finally {
      pending.current.delete(taskId);
      setStopping(new Set(pending.current));
    }
  }
  if (!count && !unavailable) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="h-5 gap-1 text-muted-foreground"
          title={description}
          aria-label={description}
        >
          {unavailable ? (
            <AlertCircle className="size-3.5" aria-hidden="true" />
          ) : active ? (
            <LoaderCircle
              className="size-3.5 motion-safe:animate-spin"
              aria-hidden="true"
            />
          ) : (
            <TerminalSquare className="size-3.5" aria-hidden />
          )}
          <span>{t('chat.backgroundTasks')}</span>
          {!!count && (
            <Badge
              variant="secondary"
              className="px-1 py-0 text-[10px] leading-3.5 tabular-nums"
            >
              {count}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)] p-0 motion-reduce:animate-none"
        aria-label={t('chat.backgroundTasks')}
      >
        <div className="border-b px-2.5 py-2">
          <h2 className="text-xs font-medium">
            {commands.length
              ? t('chat.commandSessions.summary', { running: active, retained })
              : t('chat.backgroundTasksRunning', { count: running.length })}
          </h2>
          {disabled && (
            <p role="status" className="mt-1 text-xs text-muted-foreground">
              {t('chat.commandSessions.reconnecting')}
            </p>
          )}
          {unavailable && (
            <p role="status" className="mt-1 text-xs text-muted-foreground">
              {t('chat.backgroundTasksUnavailable')}
            </p>
          )}
        </div>
        {!!count && (
          <ScrollArea
            viewportProps={{
              className: 'max-h-[min(24rem,60dvh)] [&>div]:!block',
            }}
          >
            {!!running.length && (
              <ul
                className="divide-y px-2.5"
                aria-label={t('chat.backgroundTasks')}
              >
                {running.map((task) => {
                  const label =
                    typeof task.args.label === 'string'
                      ? task.args.label.trim()
                      : '';
                  return (
                    <li
                      key={task.id}
                      className="flex items-center gap-2 py-1.5"
                    >
                      <p
                        className="min-w-0 flex-1 truncate text-xs"
                        title={
                          label ? `${label} · ${task.toolName}` : task.toolName
                        }
                      >
                        {label || task.toolName}
                      </p>
                      <Badge
                        variant="secondary"
                        className="px-1 py-0 text-[10px]"
                      >
                        {t('chat.toolRunning')}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={disabled || stopping.has(task.id)}
                        aria-label={t('chat.backgroundTaskStop', {
                          name: label || task.toolName,
                        })}
                        title={t('chat.backgroundTaskStop', {
                          name: label || task.toolName,
                        })}
                        onClick={() => void stop(task.id)}
                      >
                        {stopping.has(task.id) ? (
                          <LoaderCircle
                            className="size-3 motion-safe:animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Square className="size-3" aria-hidden="true" />
                        )}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {!!commands.length && (
              <ChatCommandSessions
                commands={commands}
                disabled={disabled || !onCleanup}
                onCleanup={onCleanup ?? (async () => {})}
              />
            )}
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
