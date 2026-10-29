import type { MarketStrategyHint } from '../../signal-types';
import { useRef, useState, type ReactNode } from 'react';
import {
  Button,
  ScrollArea,
  ScrollBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@app/plugin-ui';
import {
  ArrowLeft,
  ArrowRight,
  ChartCandlestick,
  LocateFixed,
} from 'lucide-react';
import { toast } from 'sonner';
import { DURATIONS, durationLabel } from '../../shared';
import type {
  RiskLevelRecord,
  TradeRecord,
  TradeReplay,
} from '../../strategy-types';
import { MarketChart } from '../chart';
import { DateJump } from '../date-jump';
import {
  parseChartPeriod,
  saveChartPeriod,
  type ChartPeriod,
} from '../chart-period';
import { IndicatorControls } from '../indicators/indicator-controls';
import { useIndicators } from '../indicators/use-indicators';
import type { useMarketBars } from '../use-market-bars';
import type { VolumeProfileSource } from '../indicators/main/volume-profile/use-volume-profile';
import { useCandleReplay } from '../replay/use-candle-replay';
import { ReplayControls } from '../replay/controls';
import { replayStrategyKey } from '../replay/strategy-state';
import {
  useStrategyReplay,
  type StrategyReplayView,
} from '../replay/use-strategy-replay';
import { ReplayStrategies } from '../replay/strategy-status';
import { useReplayNotifications } from '../replay/use-replay-notifications';

export type ChartBarsView = ReturnType<typeof useMarketBars>;

/** The complete center chart workspace, shared by market quotes and frozen trade replay. */
export function MarketChartPanel(props: MarketChartPanelProps) {
  return (
    <ChartWorkspace
      key={`${props.view.identity}:${props.view.windowRevision}`}
      {...props}
    />
  );
}

interface MarketChartPanelProps {
  view: ChartBarsView;
  identity: string;
  drawingSharedScope: string;
  period: ChartPeriod;
  onPeriodChange: (period: ChartPeriod) => void;
  priceTick: number;
  trade?: TradeRecord;
  markerTimes?: TradeReplay['markerTimes'];
  riskLevels?: readonly RiskLevelRecord[];
  strategyHints?: readonly MarketStrategyHint[];
  toolbarActions?: ReactNode | ((replay?: StrategyReplayView) => ReactNode);
  volumeProfileSource?: VolumeProfileSource;
  latestLabel?: string;
  emptyHint?: string;
  chartClassName?: string;
}

function ChartWorkspace({
  view,
  identity,
  drawingSharedScope,
  period,
  onPeriodChange,
  priceTick,
  trade,
  markerTimes,
  riskLevels,
  strategyHints,
  toolbarActions,
  volumeProfileSource,
  latestLabel = '最新行情',
  emptyHint = '首次订阅需要加载历史数据。请确认当前引擎具备此标的行情权限。',
  chartClassName,
}: MarketChartPanelProps) {
  const indicators = useIndicators();
  const scope = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const [replayNotifications, setReplayNotifications] = useState(true);
  const intraday = period === 'intraday';
  const duration = intraday ? 60 : period;
  const { loading } = view;
  const selectedStrategies = strategyHints ?? EMPTY_STRATEGIES;
  const strategyKey = replayStrategyKey(selectedStrategies);
  const replay = useCandleReplay(
    view.replaySource,
    view.bars,
    view.hasAfter,
    strategyKey,
  );
  const strategies = useStrategyReplay({
    pluginId: view.replaySource.pluginId,
    session: replay.session,
    duration,
    hints: selectedStrategies,
    strategyKey,
    markReady: replay.markReady,
    pause: replay.pause,
  });
  const { bars } = replay;
  const replaying = !!replay.session;
  const strategyView: StrategyReplayView | undefined = replaying
    ? {
        ...strategies,
        navigate: async (time) => {
          const success = replay.seekTime(time);
          if (!success)
            toast.error('该入场时间早于本次回放已加载范围，请重新定位回放起点');
          return success;
        },
      }
    : undefined;
  useReplayNotifications(
    replay.session,
    duration,
    strategies.pages,
    selectedStrategies,
    replayNotifications && !picking,
  );
  function changePeriod(value: string) {
    const next = parseChartPeriod(value);
    onPeriodChange(next);
    if (!saveChartPeriod(next))
      toast.error('浏览器未能保存视图周期，本次选择仅在当前页面生效', {
        id: 'chart-period-storage-error',
      });
  }
  return (
    <div
      ref={scope}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && picking) {
          event.preventDefault();
          event.stopPropagation();
          setPicking(false);
        }
      }}
    >
      <div className="@container/chart-toolbar min-w-0 border-b px-3 py-2">
        <ScrollArea viewportProps={{ className: '[&>div]:block!' }}>
          <div className="flex w-max min-w-full items-center gap-2">
            <Select value={String(period)} onValueChange={changePeriod}>
              <SelectTrigger
                size="sm"
                className="w-24 shrink-0 text-xs"
                aria-label="视图周期"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="intraday">分时图</SelectItem>
                {DURATIONS.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {durationLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <IndicatorControls
              intraday={intraday}
              preferences={indicators.preferences}
              onVisibleChange={indicators.setVisible}
              onParametersChange={indicators.setParameters}
            />
            {typeof toolbarActions === 'function'
              ? toolbarActions(strategyView)
              : toolbarActions}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
      {view.error && (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          {view.error}
        </p>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <MarketChart
          className={chartClassName}
          bars={bars}
          identity={`${identity}:${view.windowRevision}:${replay.session?.id ?? 'market'}`}
          drawingScope={identity}
          drawingSharedScope={drawingSharedScope}
          targetTime={replaying ? null : view.targetTime}
          historical={replaying || view.historical}
          onLoadMore={replaying || replay.loading ? undefined : view.loadMore}
          replay={replaying}
          onSelectReplayTime={
            picking
              ? (time) => {
                  replay.selectTime(time);
                  setPicking(false);
                }
              : undefined
          }
          duration={duration}
          intraday={intraday}
          priceTick={priceTick}
          indicators={indicators.preferences}
          trade={trade}
          markerTimes={markerTimes}
          riskLevels={riskLevels}
          strategyHints={replaying ? strategies.items : strategyHints}
          volumeProfileSource={volumeProfileSource}
        />
        {!bars.length && (
          <div className="absolute inset-0 flex items-center justify-center px-8 text-center">
            <div className="max-w-sm rounded-lg bg-card/95 p-5">
              <ChartCandlestick className="mx-auto mb-3 size-8 text-muted-foreground" />
              <p className="text-sm font-medium">
                {loading
                  ? intraday
                    ? '正在读取分时行情…'
                    : '正在读取 K 线…'
                  : '暂无行情数据'}
              </p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {emptyHint}
              </p>
            </div>
          </div>
        )}
      </div>
      {!intraday && (
        <ReplayControls
          replay={replay}
          duration={duration}
          picking={picking}
          onPickingChange={setPicking}
          scope={scope}
          disabled={loading || !bars.length}
          defaultTime={
            view.targetTime ?? bars[Math.max(0, bars.length - 100)]?.time
          }
          historical={!!trade}
          linkedStrategies={!!strategyKey}
          navigation={
            <>
              <DateJump
                key={identity}
                defaultTime={view.targetTime ?? bars.at(-1)?.time}
                duration={duration}
                loading={loading}
                onJump={view.navigate}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={loading}
                onClick={() => void view.navigate(null)}
              >
                <LocateFixed className="size-4" />
                {latestLabel}
              </Button>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="加载更早行情"
                  disabled={
                    loading ||
                    !bars.length ||
                    !view.hasBefore ||
                    view.beforeLoading
                  }
                  onClick={() => void view.loadMore('before')}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <span role="status" className="text-xs text-muted-foreground">
                  {view.beforeLoading
                    ? '正在加载更早行情…'
                    : view.afterLoading
                      ? '正在加载后续行情…'
                      : '拖动到边缘自动加载'}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="加载后续行情"
                  disabled={
                    loading ||
                    !bars.length ||
                    !view.hasAfter ||
                    view.afterLoading
                  }
                  onClick={() => void view.loadMore('after')}
                >
                  <ArrowRight className="size-4" />
                </Button>
              </div>
            </>
          }
        />
      )}
      {strategyView && !!strategyKey && (
        <ReplayStrategies
          view={strategyView}
          notifications={replayNotifications}
          onNotificationsChange={setReplayNotifications}
        />
      )}
    </div>
  );
}

const EMPTY_STRATEGIES: MarketStrategyHint[] = [];
