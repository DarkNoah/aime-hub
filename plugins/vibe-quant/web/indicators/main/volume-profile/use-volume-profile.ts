import { useEffect, useMemo, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  PROFILE_DAY,
  PROFILE_RANGES,
  PROFILE_SOURCE,
  profileWindow,
  type ProfileRange,
  type VolumeProfileData,
} from '../../../../volume-profile';
import type { IndicatorPreference } from '../../types';

export interface VolumeProfileSource {
  pluginId: string;
  path: string;
}
const EMPTY: VolumeProfileData = {
  segments: [],
  source: PROFILE_SOURCE,
  warnings: [],
};

export function useVolumeProfile(
  source: VolumeProfileSource | undefined,
  preference: IndicatorPreference | undefined,
  first: number | undefined,
  lastEnd: number | undefined,
  duration: number,
  historical: boolean,
  intraday: boolean,
  historyEnd: number | undefined,
  identity: string,
) {
  const enabled = !!preference?.visible && !intraday;
  const range = String(preference?.parameters.range ?? '1d') as ProfileRange;
  const span = PROFILE_RANGES[range] ?? PROFILE_DAY;
  const showCurrent = !!preference?.parameters.showCurrent;
  const rowSize = Number(preference?.parameters.rowSize ?? 30);
  const valueAreaVolume = Number(preference?.parameters.valueAreaVolume ?? 70);
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!enabled || historical) return;
    const timer = setInterval(
      () => setClock(Math.floor(Date.now() / 1000)),
      30_000,
    );
    return () => clearInterval(timer);
  }, [enabled, historical]);
  const asOf =
    historical && historyEnd !== undefined
      ? Math.min(historyEnd, clock)
      : clock;
  const window =
    first === undefined || lastEnd === undefined
      ? null
      : profileWindow(first, lastEnd, span, asOf, showCurrent);
  const supported =
    duration <= PROFILE_DAY &&
    !(duration === PROFILE_DAY && span < PROFILE_DAY);
  const from = window?.from ?? 0,
    to = Math.floor(window?.to ?? 0);
  const clipped = !!window?.clipped;
  const pluginId = source?.pluginId ?? '',
    path = source?.path ?? '';
  const query = new URLSearchParams({
    from: String(from),
    to: String(to),
    range,
    rowSize: String(rowSize),
    valueAreaVolume: String(valueAreaVolume),
  }).toString();
  const key =
    enabled && supported && path && to > from
      ? `${identity}:${pluginId}:${path}:${query}`
      : '';
  const [loaded, setLoaded] = useState<{
    key: string;
    data: VolumeProfileData;
  }>({ key: '', data: EMPTY });
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void pluginRequest<VolumeProfileData>(
        pluginId,
        `${path}${path.includes('?') ? '&' : '?'}${query}`,
        { signal: controller.signal },
      )
        .then((data) => {
          if (!controller.signal.aborted) setLoaded({ key, data });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setLoaded({
              key,
              data: {
                ...EMPTY,
                warnings: [
                  '成交量分布读取失败，请稍后重试或检查通达信分笔数据源。',
                ],
              },
            });
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // Refresh persisted current-day snapshots, including completed minute ranges.
  }, [key, pluginId, path, query, clock]);
  const data = key && loaded.key === key ? loaded.data : EMPTY;
  const context = useMemo(
    () => ({
      volumeProfile: enabled
        ? {
            ...data,
            warnings: [
              ...data.warnings,
              ...(clipped
                ? [
                    '成交量分布仅计算可见范围右侧最多 60 天 / 240 段，请缩小范围查看。',
                  ]
                : []),
              ...(!path ? ['当前图表未提供成交量分布数据源。'] : []),
            ],
          }
        : undefined,
    }),
    [data, enabled, clipped, path],
  );
  return {
    context,
    enabled,
    pending: !!key && loaded.key !== key,
    count: data.segments.length,
  };
}
