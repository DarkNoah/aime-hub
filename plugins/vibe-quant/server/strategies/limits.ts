/** Bounded multi-year research runs; keep snapshot and artifact limits consistent. */
export const MAX_BACKTEST_SECONDS = 10 * 366 * 86400;
export const MAX_BACKTEST_BARS = 500_000;
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
