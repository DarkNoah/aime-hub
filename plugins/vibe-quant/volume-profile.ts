// Price binning, POC ties and value-area expansion match stock-rl.
export const PROFILE_DAY = 86400;
export const PROFILE_OFFSET = 8 * 3600;
export const PROFILE_RANGES = {
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '3h': 10800,
  '4h': 14400,
  '5h': 18000,
  '1d': 86400,
  '2d': 172800,
  '3d': 259200,
  '5d': 432000,
} as const;
export type ProfileRange = keyof typeof PROFILE_RANGES;
export const PROFILE_SOURCE = '通达信分笔成交 · 非交易所完整逐笔';
export const PROFILE_LIMIT = 240;
export interface ProfileTrade {
  price: number;
  size: number;
  side: 'buy' | 'sell' | 'unknown';
}
export interface ProfileRow {
  low: number;
  high: number;
  buy: number;
  sell: number;
  unknown: number;
  total: number;
  inValueArea: boolean;
}
export interface PriceProfile {
  rows: ProfileRow[];
  total: number;
  poc: number;
  val: number;
  vah: number;
  vwap: number;
  coverage: number;
}
export interface ProfileSegment {
  start: number;
  end: number;
  profile: PriceProfile;
}
export interface VolumeProfileData {
  segments: ProfileSegment[];
  source: string;
  warnings: string[];
}
/** All public times are UTC epoch seconds; the fixed anchor is Beijing midnight. */
export function profileRangeStart(time: number, span: number) {
  return Math.floor((time + PROFILE_OFFSET) / span) * span - PROFILE_OFFSET;
}
export function profileWindow(
  first: number,
  lastEnd: number,
  span: number,
  asOf: number,
  showCurrent: boolean,
) {
  const to = Math.min(
    profileRangeStart(lastEnd - 0.001, span) + span,
    showCurrent ? asOf : profileRangeStart(asOf, span),
  );
  const start = profileRangeStart(first, span);
  const from = Math.max(
    start,
    to - Math.min(60 * PROFILE_DAY, PROFILE_LIMIT * span),
  );
  // Keep the left edge aligned even when the current interval is incomplete.
  const aligned =
    Math.ceil((from + PROFILE_OFFSET) / span) * span - PROFILE_OFFSET;
  return { from: aligned, to, clipped: aligned > start };
}
export function buildPriceProfile(
  trades: readonly ProfileTrade[],
  rowSize: number,
  valueAreaVolume: number,
): PriceProfile | null {
  const valid = trades.filter(
    (t) =>
      Number.isFinite(t.price) &&
      t.price > 0 &&
      Number.isFinite(t.size) &&
      t.size > 0,
  );
  if (!valid.length) return null;
  let min = Infinity,
    max = -Infinity,
    total = 0,
    weighted = 0;
  for (const trade of valid) {
    min = Math.min(min, trade.price);
    max = Math.max(max, trade.price);
    total += trade.size;
    weighted += trade.price * trade.size;
  }
  // A single traded price occupies a single narrow row rather than dividing by zero.
  const count =
    max === min ? 1 : Math.max(2, Math.min(200, Math.round(rowSize)));
  const height =
    max === min ? Math.max(0.00000001, min * 0.00001) : (max - min) / count;
  const base = max === min ? min - height / 2 : min;
  const rows: ProfileRow[] = Array.from({ length: count }, (_, i) => ({
    low: base + i * height,
    high: base + (i + 1) * height,
    buy: 0,
    sell: 0,
    unknown: 0,
    total: 0,
    inValueArea: false,
  }));
  for (const trade of valid) {
    // searchsorted(edges, side='right'), including exact interior boundaries.
    let low = 0,
      high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (rows[mid].low <= trade.price) low = mid + 1;
      else high = mid;
    }
    const row = rows[Math.max(0, low - 1)];
    row[trade.side] += trade.size;
    row.total += trade.size;
  }
  // np.idxmax semantics: first (lowest) row wins a POC tie.
  let pocRow = 0;
  for (let i = 1; i < count; i++)
    if (rows[i].total > rows[pocRow].total) pocRow = i;
  let lower = pocRow,
    upper = pocRow,
    selected = rows[pocRow].total;
  const target = (total * Math.max(0, Math.min(100, valueAreaVolume))) / 100;
  while (selected < target && (lower > 0 || upper < count - 1)) {
    const below = lower > 0 ? rows[lower - 1].total : -1;
    const above = upper < count - 1 ? rows[upper + 1].total : -1;
    if (above >= below) selected += rows[++upper].total;
    else selected += rows[--lower].total;
  }
  for (let i = lower; i <= upper; i++) rows[i].inValueArea = true;
  return {
    rows,
    total,
    poc: (rows[pocRow].low + rows[pocRow].high) / 2,
    val: rows[lower].low,
    vah: rows[upper].high,
    vwap: weighted / total,
    coverage: selected / total,
  };
}
