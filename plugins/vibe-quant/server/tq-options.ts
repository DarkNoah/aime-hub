import type { QuantConfig } from './config.js';
import type { BacktestInput } from '../strategy-types.js';
/** Freeze resolved defaults when a job is created; later settings never rewrite its assumptions. */
export function resolveTqOptions(
  config: QuantConfig,
  overrides?: BacktestInput['tq_options'],
) {
  return {
    ...(config.tqSimCommissionPerLot === undefined
      ? {}
      : { commission_per_lot: config.tqSimCommissionPerLot }),
    ...(config.tqSimMarginPerLot === undefined
      ? {}
      : { margin_per_lot: config.tqSimMarginPerLot }),
    ...Object.fromEntries(
      Object.entries(overrides ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  };
}
export const actualFuture =
  /^(CFFEX|SHFE|DCE|CZCE|INE|GFEX)\.[A-Za-z]+\d{3,4}$/;
