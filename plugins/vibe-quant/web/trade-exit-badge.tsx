import { Badge } from '@app/plugin-ui';
import { exitReasonLabel } from './trade-exit';

export function TradeExitBadge({
  reason,
  note,
}: {
  reason?: string;
  note?: string;
}) {
  return (
    <>
      <Badge
        variant="outline"
        title={reason}
        className={
          reason === 'take_profit'
            ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
            : reason === 'stop_loss'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : undefined
        }
      >
        {exitReasonLabel(reason)}
      </Badge>
      {note ? (
        <span className="ms-1.5 whitespace-normal break-words text-xs text-muted-foreground">
          {note}
        </span>
      ) : null}
    </>
  );
}
