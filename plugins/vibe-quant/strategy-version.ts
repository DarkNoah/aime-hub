import type { StrategyVersion } from './strategy-types.js';

type NamedVersion = Pick<StrategyVersion, 'number' | 'name'>;

export const strategyVersionName = (version: NamedVersion) =>
  version.name ?? `v${version.number}`;

export const runVersionName = (run: {
  version_number: number;
  version_name?: string;
}) => run.version_name ?? `v${run.version_number}`;

export function nextOptimizationVersionName(
  source: NamedVersion,
  versions: NamedVersion[],
) {
  const prefix = `${strategyVersionName(source)}.opt.v`;
  const last = versions.reduce((max, version) => {
    const name = strategyVersionName(version);
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    return /^\d+$/.test(suffix) ? Math.max(max, Number(suffix)) : max;
  }, 0);
  return `${prefix}${last + 1}`;
}

/** Optimization branches do not consume ordinary version names. */
export function nextStrategyVersionName(versions: NamedVersion[]) {
  const last = versions.reduce((max, version) => {
    const match = /^v(\d+)$/.exec(strategyVersionName(version));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `v${last + 1}`;
}
