export type InstrumentKind = 'stock' | 'future' | 'option' | 'continuous';
export type Engine = 'tqsdk' | 'tushare' | 'tdx';
export interface Instrument {
  symbol: string;
  name: string;
  kind: InstrumentKind;
  exchange: string;
  product: string;
  priceTick: number;
  underlying: string;
  expired: boolean;
}
export interface WatchItem extends Instrument {
  enabled: boolean;
}
export interface Quote {
  symbol: string;
  time: number;
  last: number | null;
  preClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  amount: number | null;
  openInterest: number | null;
  bid: number | null;
  ask: number | null;
  underlying: string;
}
/** One observed depth snapshot; array index 0 is the best bid/ask. Times are epoch seconds. */
export interface OrderBook {
  snapshotId: string;
  symbol: string;
  sourceTime: number | null;
  receivedAt: number;
  timePrecision: 'exchange' | 'unknown';
  bidPrices: (number | null)[];
  bidVolumes: (number | null)[];
  askPrices: (number | null)[];
  askVolumes: (number | null)[];
  volumeUnit: 'share' | 'source';
  underlying: string;
}
export interface Bar {
  symbol: string;
  duration: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
/** SDK market snapshot, not an individual execution. UInt64 values use decimal strings. */
export interface Tick {
  symbol: string;
  tickId: string;
  timeNs: string;
  tradingDay: string;
  receivedAt: number;
  last: number | null;
  volume: number | null;
  amount: number | null;
  openInterest: number | null;
  bid: number | null;
  bidVolume: number | null;
  ask: number | null;
  askVolume: number | null;
  priceTick: number | null;
  volumeMultiple: number | null;
  volumeUnit: 'source';
}
export interface TickVolumeValidation {
  symbol: string;
  tradingDay: string;
  checkedAt: string;
  state: 'empty' | 'partial' | 'consistent' | 'warning';
  message: string;
  rows: number;
  firstTimeNs: string | null;
  lastTimeNs: string | null;
  baselineVolume: number | null;
  lastVolume: number | null;
  observedVolume: number;
  gapVolume: number;
  sequenceGaps: number;
  volumeRegressions: number;
  amountRegressions: number;
  invalidRows: number;
  checkedMinutes: number;
  mismatchedMinutes: number;
  uncheckedMinutes: number;
}
export interface SyncStatus {
  engine: Engine;
  state: 'starting' | 'syncing' | 'closed' | 'idle' | 'error' | 'standby';
  message: string;
  updatedAt: string | null;
  lastWriteAt: string | null;
  lastReceivedAt: string | null;
  clickhouseReadOnly: boolean;
  subscriptions: number;
  active: number;
  catalogCount: number;
  beforeOpenMinutes: number;
  afterCloseMinutes: number;
  tickValidation?: TickVolumeValidation[];
  tickValidationError?: string | null;
}
// API identifier for calendar months, not a fixed 30-day aggregation window.
export const MONTH_DURATION = 2592000;
export const DURATIONS = [
  60,
  180,
  300,
  900,
  1800,
  3600,
  86400,
  MONTH_DURATION,
] as const;
export const durationLabel = (duration: number) =>
  duration === MONTH_DURATION
    ? '月线'
    : duration === 86400
      ? '日线'
      : `${duration / 60} 分钟`;
export const KIND_LABELS: Record<InstrumentKind, string> = {
  stock: '股票 / 指数',
  future: '期货',
  option: '期权合约',
  continuous: '主连',
};
