import { useEffect, useRef } from 'react';
import {
  enableNotificationSound,
  playNotificationSound,
  showMarketSignalToast,
} from '@app/plugin-ui';
import { toast } from 'sonner';
import type { MarketStrategyHint } from '../../signal-types';
import type { SignalHistoryPage } from '../../signal-history';
import { replayBarEnd } from '../../replay-types';
import { strategyNotifications } from '../../strategy-notifications';
import { dateTime, number } from '../strategies/format';
import { exitReasonLabel } from '../trade-exit';
import type { ReplaySession } from './use-candle-replay';
import { replayStrategyKey } from './strategy-state';

export function useReplayNotifications(
  session: ReplaySession | null,
  duration: number,
  pages: Record<string, SignalHistoryPage>,
  hints: readonly MarketStrategyHint[],
  enabled: boolean,
) {
  const previous = useRef<{
    key: string;
    time: number;
    signals: Set<string>;
  } | null>(null);
  const shown = useRef(
    new Map<string, { time: number; desktop?: Notification }>(),
  );
  const time = session
    ? replayBarEnd(session.bars[session.index].time, duration)
    : 0;
  const key = session
    ? `${session.id}:${session.notificationEpoch}:${replayStrategyKey(hints)}`
    : '';
  useEffect(() => {
    if (!session) return;
    const unlock = (event: Event) => {
      if (event.isTrusted) void enableNotificationSound();
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, [session?.id]);
  useEffect(() => {
    return () => {
      for (const [id, value] of shown.current) {
        toast.dismiss(id);
        value.desktop?.close();
      }
      shown.current.clear();
      toast.dismiss('replay-sound-unlock');
    };
  }, [key]);
  useEffect(() => {
    if (!session || hints.some((hint) => hint.enabled && !pages[hint.id]))
      return;
    const signals = new Set(
      Object.entries(pages).flatMap(([id, page]) =>
        page.signals.map((signal) => `${id}:${signal.id}`),
      ),
    );
    const old = previous.current;
    previous.current = { key, time, signals };
    if (!old || old.key !== key) return;
    if (time < old.time) {
      for (const [id, value] of shown.current)
        if (value.time > time) {
          toast.dismiss(id);
          value.desktop?.close();
          shown.current.delete(id);
        }
      return;
    }
    if (!enabled || time === old.time) return;
    for (const hint of hints) {
      if (!hint.enabled || hint.notifications_enabled === false) continue;
      const channels = strategyNotifications(hint.notifications).channels;
      for (const signal of [...(pages[hint.id]?.signals ?? [])].reverse()) {
        if (
          old.signals.has(`${hint.id}:${signal.id}`) ||
          !hint.config.events[signal.type]
        )
          continue;
        const id = `replay:${session.id}:${hint.id}:${signal.id}`;
        const side =
          signal.side === 'long'
            ? '多头'
            : signal.side === 'short'
              ? '空头'
              : '';
        const title = `回放 · ${hint.strategy_name} · ${side}${signal.type === 'entry' ? '入场' : '离场'}信号`;
        const body = `${signal.symbol} · v${hint.version_number} · ${dateTime(signal.time)}${signal.price === null ? '' : ` · 参考价 ${number(signal.price)}`}${signal.reason ? ` · ${signal.type === 'exit' ? exitReasonLabel(signal.reason) : signal.reason}` : ''}`;
        if (channels.toast?.enabled)
          showMarketSignalToast({
            id,
            title,
            body,
            marketSignal: {
              type: signal.type,
              side: signal.side,
              strategyName: hint.strategy_name,
              version: hint.version_number,
              symbol: signal.symbol,
              time: signal.time,
              price: signal.price,
              reason:
                signal.type === 'exit'
                  ? exitReasonLabel(signal.reason)
                  : signal.reason,
              replay: true,
            },
            onConfirm: () => {
              shown.current.get(id)?.desktop?.close();
              shown.current.delete(id);
            },
          });
        let desktop: Notification | undefined;
        if (
          channels.desktop?.enabled &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted'
        ) {
          try {
            desktop = new Notification(title, { body, tag: id });
          } catch {
            /* Browser/system may restrict desktop delivery. */
          }
        }
        if (
          channels.sound?.enabled &&
          playNotificationSound(signal.type) === 'blocked'
        )
          toast('回放提示音尚未启用', {
            id: 'replay-sound-unlock',
            action: {
              label: '启用声音',
              onClick: () => {
                void enableNotificationSound();
              },
            },
          });
        shown.current.set(id, { time, desktop });
      }
    }
  }, [key, time, pages, hints, enabled, session]);
}
