import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  LogIn,
  LogOut,
  Minus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { MarketSignalNotification } from '@aime/shared/notifications';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

export type SignalToastProps = {
  id: string;
  title: string;
  body: string;
  marketSignal?: MarketSignalNotification;
  onConfirm?: () => void;
};

const directionStyles = {
  long: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300',
  short:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  unknown: 'border-border bg-muted text-foreground',
};
const directionIcons = {
  long: ArrowUpRight,
  short: ArrowDownRight,
  unknown: Minus,
};
const signalStyles = {
  entry:
    'border-blue-700 bg-blue-700 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-blue-950',
  exit: 'border-orange-700 bg-orange-700 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-orange-950',
};
const signalIcons = { entry: LogIn, exit: LogOut };

export function MarketSignalToast({
  id,
  title,
  body,
  marketSignal: signal,
  onConfirm,
}: SignalToastProps) {
  const { t, i18n } = useTranslation();
  const DirectionIcon = directionIcons[signal?.side ?? 'unknown'];
  const SignalIcon = signalIcons[signal?.type ?? 'entry'];
  return (
    <section
      aria-label={title}
      className="w-full rounded-xl border bg-card p-4 text-foreground"
    >
      {signal ? (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge
              asChild
              variant="outline"
              className={`${signalStyles[signal.type]} gap-2 px-3 py-1.5 text-lg font-semibold [&>svg]:size-5`}
            >
              <h3>
                <SignalIcon aria-hidden="true" />
                {t(`notifications.signal.${signal.type}`)}
              </h3>
            </Badge>
            <Badge
              variant="outline"
              className={`${directionStyles[signal.side]} px-2.5 py-1 text-sm [&>svg]:size-4`}
            >
              <DirectionIcon aria-hidden="true" />
              {t(`notifications.signal.${signal.side}`)}
            </Badge>
            {signal.replay && (
              <Badge variant="secondary">
                {t('notifications.signal.replay')}
              </Badge>
            )}
          </div>
          <ScrollArea
            className="mt-3"
            viewportProps={{ className: 'h-auto max-h-[min(22rem,50dvh)]' }}
          >
            <div className="space-y-3 pr-2 text-sm [overflow-wrap:anywhere]">
              <div>
                <p className="text-xs text-muted-foreground">
                  {t('notifications.signal.strategy')}
                </p>
                <p className="mt-1 font-semibold leading-5">
                  {signal.strategyName}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    v{signal.version}
                  </span>
                </p>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                <dt className="text-muted-foreground">
                  {t('notifications.signal.symbol')}
                </dt>
                <dd className="text-right font-medium">{signal.symbol}</dd>
                {signal.price !== null && (
                  <>
                    <dt className="text-muted-foreground">
                      {t('notifications.signal.price')}
                    </dt>
                    <dd className="text-right font-medium tabular-nums">
                      {signal.price}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">
                  {t('notifications.signal.time')}
                </dt>
                <dd className="text-right tabular-nums">
                  {new Date(signal.time * 1000).toLocaleString(i18n.language, {
                    timeZone: 'Asia/Shanghai',
                    hour12: false,
                  })}
                </dd>
              </dl>
              {signal.reason && (
                <p className="border-t pt-2 text-xs leading-5">
                  <span className="mr-2 text-muted-foreground">
                    {t('notifications.signal.reason')}
                  </span>
                  {signal.reason}
                </p>
              )}
            </div>
          </ScrollArea>
        </>
      ) : (
        <>
          <h3 className="text-base font-semibold [overflow-wrap:anywhere]">
            {title}
          </h3>
          <ScrollArea
            className="mt-2"
            viewportProps={{ className: 'h-auto max-h-[min(22rem,50dvh)]' }}
          >
            <p className="text-sm leading-6 [overflow-wrap:anywhere]">{body}</p>
          </ScrollArea>
        </>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          {t('notifications.signal.confirmHint')}
        </span>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            onConfirm?.();
            toast.dismiss(id);
          }}
        >
          <Check aria-hidden="true" />
          {t('notifications.signal.confirm')}
        </Button>
      </div>
    </section>
  );
}
