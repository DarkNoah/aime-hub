import type { MarketPositionMonitor } from '../../market-positions';
import { monitorExecutionModel } from '../../signal-types';
import type { Quote } from '../../shared';
import type { OpenTrade } from '../../strategy-types';

export function positionValuation(
  trade: OpenTrade,
  monitor: MarketPositionMonitor,
  quote?: Quote,
  quoteEngine?: string,
) {
  const model = monitorExecutionModel(monitor.config);
  const multiplier =
    trade.pnl_multiplier ??
    (model === 'points' || model === 'continuous_price'
      ? 1
      : monitor.config.simulation_engine !== 'tqsdk'
        ? monitor.config.rules?.multiplier
        : undefined);
  // Never mark a replayed position with future prices, another contract or another engine.
  if (
    !monitor.replaying &&
    quoteEngine === monitor.engine &&
    quote?.symbol === trade.symbol &&
    quote.last != null &&
    Number.isFinite(quote.last) &&
    quote.time >= trade.observed_until &&
    multiplier != null &&
    Number.isFinite(multiplier) &&
    multiplier > 0
  ) {
    return {
      value:
        (quote.last - trade.entry_price) *
          (trade.side === 'long' ? 1 : -1) *
          trade.quantity *
          multiplier -
        trade.fees,
      price: quote.last,
      time: quote.time,
    };
  }
  return {
    value: trade.unrealized_pnl ?? null,
    price: trade.mark_price ?? null,
    time: trade.observed_until,
  };
}
