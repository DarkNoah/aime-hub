import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { Badge, Button } from '@app/plugin-ui';
import type {
  BacktestRun,
  RiskLevelRecord,
  TradeRecord,
} from '../../strategy-types';
import { tradeExitAnchor } from '../../strategy-types';
import { exitReasonLabel } from '../trade-exit';
import { parseChartPeriod } from '../chart-period';
import { MarketChartPanel } from '../components/market-chart-panel';
import { dateTime, number } from './format';
import { useMarketBars } from '../use-market-bars';
import { tradeRiskLevels } from '../trade-risk';
import { TradeRiskHistory } from './trade-risk-history';

const EMPTY_RISK_LEVELS: RiskLevelRecord[] = [];

export default function BacktestMarketChart({
  pluginId,
  run,
  selection,
  riskLevels = EMPTY_RISK_LEVELS,
  onClearSelection,
}: {
  pluginId: string;
  run: BacktestRun;
  // A fresh selection also allows replaying the same trade after panning away.
  selection: { trade: TradeRecord } | null;
  riskLevels?: RiskLevelRecord[];
  onClearSelection: () => void;
}) {
  const [period, setPeriod] = useState(() =>
    parseChartPeriod(String(run.config.duration)),
  );
  const [retry, setRetry] = useState(0);
  const [showRisk, setShowRisk] = useState(true);
  const trade = selection?.trade;
  const symbol = trade?.symbol ?? run.config.symbol;
  const native = run.config.backtest_engine === 'tqsdk';
  const points = run.config.execution_model === 'points';
  const exitTime = trade ? tradeExitAnchor(trade) : null;
  const levels = useMemo(
    () => (trade ? tradeRiskLevels(trade, riskLevels) : EMPTY_RISK_LEVELS),
    [trade, riskLevels],
  );
  const sharedScope = `backtest:${run.id}:${symbol}`;
  const marketPath = `/strategies/runs/${run.id}`;
  const symbolQuery = `symbol=${encodeURIComponent(symbol)}`;
  const view = useMarketBars({
    pluginId,
    symbol,
    duration: period === 'intraday' ? 60 : period,
    intraday: period === 'intraday',
    identity: `${sharedScope}:${period}`,
    retry,
    barsPath: `${marketPath}/bars?${symbolQuery}${native && period === 'intraday' ? '&snapshot_intraday=true' : ''}`,
    initialTime: Math.floor(run.config.start),
    live: false,
  });
  const locateSelection = useEffectEvent(() => {
    void view.navigate(Math.floor(trade?.entry_time ?? run.config.start));
  });
  useEffect(() => {
    if (selection) locateSelection();
  }, [selection]);

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">行情图</h3>
          <span className="font-mono text-xs">{symbol}</span>
          {trade && (
            <Badge variant="outline">
              {trade.side === 'long' ? '多头' : '空头'} · {trade.quantity}
            </Badge>
          )}
          {trade?.status === 'open' && (
            <Badge variant="secondary">未平仓</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={view.loading}
            onClick={() => void view.navigate(Math.floor(run.config.start))}
          >
            回测开始
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={view.loading}
            onClick={() => void view.navigate(Math.floor(run.config.end) - 1)}
          >
            回测结束
          </Button>
          {trade && (
            <Button size="sm" variant="outline" onClick={onClearSelection}>
              清除交易选择
            </Button>
          )}
        </div>
      </div>
      {trade ? (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <Button
              size="sm"
              variant="outline"
              disabled={view.loading}
              onClick={() => void view.navigate(Math.floor(trade.entry_time))}
            >
              入场 {dateTime(trade.entry_time)} · {number(trade.entry_price)}
            </Button>
            {exitTime !== null && (
              <Button
                size="sm"
                variant="outline"
                disabled={view.loading}
                onClick={() => void view.navigate(Math.floor(exitTime))}
              >
                离场 {dateTime(trade.exit_time)} · {number(trade.exit_price)}
              </Button>
            )}
            {trade.status !== 'open' && (
              <Badge variant="outline" title={trade.exit_reason}>
                {exitReasonLabel(trade.exit_reason)}
              </Badge>
            )}
            {trade.trigger_price != null && (
              <span className="text-xs text-muted-foreground">
                触发价 {number(trade.trigger_price)}
              </span>
            )}
            <span className="ml-auto text-xs tabular-nums">
              {trade.status === 'open'
                ? `未平仓数量 ${trade.quantity}`
                : `净收益 ${number(trade.net_pnl)}${points ? ' 点' : ''}`}
            </span>
          </div>
          {trade.exit_time_precision === 'bar' && (
            <p className="border-b px-4 py-2 text-xs text-muted-foreground">
              该根 K 线内触发自动平仓，记录时间为 {dateTime(trade.exit_time)}（K
              线结束）；图中标记定位成交所属 K 线。
            </p>
          )}
          {trade.trigger_bar_time != null &&
            trade.trigger_bar_time !== trade.exit_bar_time && (
              <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                于 {dateTime(trade.trigger_time)} 触发，
                {native ? '模拟委托随后成交' : '受成交量或 T+1 限制延后成交'}
                ；平仓沿用触发时的原因和价格依据。
              </p>
            )}
          <TradeRiskHistory
            key={trade.id}
            records={levels}
            triggeredId={trade.risk_level_id}
            visible={showRisk}
            onVisibleChange={setShowRisk}
            onNavigate={(time) => void view.navigate(Math.floor(time))}
          />
        </>
      ) : (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          {dateTime(run.config.start)} — {dateTime(run.config.end)}
          {' · 点击交易记录中的“回放”，在此图定位入场日期。'}
        </p>
      )}
      <div className="flex h-[640px] min-w-0 flex-col">
        <MarketChartPanel
          view={{
            ...view,
            navigate: (time) =>
              view.navigate(time ?? Math.floor(run.config.end) - 1),
          }}
          identity={`${sharedScope}:${period}`}
          drawingSharedScope={sharedScope}
          period={period}
          onPeriodChange={setPeriod}
          priceTick={view.priceTick ?? 0.01}
          volumeProfileSource={
            native
              ? undefined
              : {
                  pluginId,
                  path: `${marketPath}/volume-profile?${symbolQuery}`,
                }
          }
          trade={trade}
          riskLevels={showRisk ? levels : EMPTY_RISK_LEVELS}
          latestLabel="回测结束"
          chartClassName="min-h-[360px]"
          emptyHint="可跳转日期或拖动图表继续浏览本次回测标的的行情。"
        />
      </div>
      {view.error && (
        <Button
          size="sm"
          variant="outline"
          className="m-3"
          onClick={() => setRetry((value) => value + 1)}
        >
          重新加载行情
        </Button>
      )}
      <p className="border-t px-4 py-2 text-xs leading-5 text-muted-foreground">
        {native
          ? '行情取自本次天勤回测保存的快照，包含预热窗口；拖动到快照边界后不再加载。'
          : '行情取自行情库，可拖动浏览完整历史；成交标记取自本次回测记录。'}
        {trade && ' 蓝色标记为入场，橙色标记为离场。'}
      </p>
    </div>
  );
}
