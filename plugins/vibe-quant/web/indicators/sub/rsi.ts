// Port of the user's “Relative strength index” Pine Script; see rsi/source.pine.
import { points, priceSourceParameter, priceValues } from '../calculations';
import type {
  IndicatorDefinition,
  IndicatorDrawing,
  IndicatorFill,
  IndicatorPlot,
} from '../types';
import {
  relativeStrengthIndex,
  rsiDivergences,
  rsiStandardDeviation,
  smoothRsi,
} from './rsi/engine';

export const rsiIndicator: IndicatorDefinition = {
  id: 'rsi',
  type: 'sub',
  name: 'RSI',
  description:
    'Wilder RSI，显示 70 / 50 / 30 参考线，可选平滑均线、布林带与常规背离。背离需右侧 5 根 K 线确认，标记回画到拐点；盘中末根 K 线可能修订。',
  source: { name: '用户提供的 Relative strength index · Pine Script v6' },
  defaultVisible: false,
  priceFormat: 'oscillator',
  precision: 2,
  parameters: [
    {
      key: 'rsiLength',
      label: 'RSI 周期',
      type: 'number',
      default: 14,
      min: 1,
      integer: true,
      group: 'RSI 设置',
    },
    { ...priceSourceParameter, group: 'RSI 设置' },
    {
      key: 'calculateDivergence',
      label: '计算并显示背离',
      type: 'boolean',
      default: false,
      group: 'RSI 设置',
      description:
        '显示 Bull 看涨 / Bear 看跌背离。左右各 5 根确认，沿用原脚本的相邻拐点距离判断。',
    },
    {
      key: 'maType',
      label: '平滑类型',
      type: 'select',
      default: 'sma',
      group: '平滑设置',
      options: [
        { value: 'none', label: '无' },
        { value: 'sma', label: 'SMA 简单移动平均' },
        { value: 'sma-bb', label: 'SMA + 布林带' },
        { value: 'ema', label: 'EMA 指数移动平均' },
        { value: 'rma', label: 'SMMA / RMA 平滑移动平均' },
        { value: 'wma', label: 'WMA 加权移动平均' },
        { value: 'vwma', label: 'VWMA 成交量加权平均' },
      ],
    },
    {
      key: 'maLength',
      label: '平滑周期',
      type: 'number',
      default: 14,
      min: 1,
      integer: true,
      group: '平滑设置',
    },
    {
      key: 'bbMult',
      label: '布林带标准差倍数',
      type: 'number',
      default: 2,
      min: 0.001,
      max: 50,
      step: 0.5,
      group: '平滑设置',
      description: '仅在 SMA + 布林带模式生效。VWMA 遇到窗口成交量为零时留空。',
    },
    {
      key: 'showFills',
      label: '显示区域与渐变填充',
      type: 'boolean',
      default: true,
      group: '显示样式',
    },
    {
      key: 'lineWidth',
      label: 'RSI 线宽',
      type: 'number',
      default: 2,
      min: 1,
      max: 4,
      integer: true,
      group: '显示样式',
    },
    {
      key: 'rsiColor',
      label: 'RSI 颜色',
      type: 'color',
      default: '#7e57c2',
      group: '颜色',
    },
    {
      key: 'maColor',
      label: '平滑线颜色',
      type: 'color',
      default: '#fdd835',
      group: '颜色',
    },
    {
      key: 'bandColor',
      label: '布林带颜色',
      type: 'color',
      default: '#4caf50',
      group: '颜色',
    },
    {
      key: 'bullColor',
      label: '看涨背离 / 超买颜色',
      type: 'color',
      default: '#4caf50',
      group: '颜色',
    },
    {
      key: 'bearColor',
      label: '看跌背离 / 超卖颜色',
      type: 'color',
      default: '#f23645',
      group: '颜色',
    },
  ],
  render(bars, parameters) {
    const rsi = relativeStrengthIndex(
      priceValues(bars, String(parameters.priceSource)),
      Number(parameters.rsiLength),
    );
    const color = String(parameters.rsiColor);
    const bullColor = String(parameters.bullColor),
      bearColor = String(parameters.bearColor);
    const drawings: IndicatorDrawing[] = [];
    if (parameters.calculateDivergence) {
      for (const event of rsiDivergences(bars, rsi)) {
        const bull = event.kind === 'bull';
        const eventColor = bull ? bullColor : bearColor;
        drawings.push({
          id: `rsi-${event.kind}-${event.to}`,
          kind: 'line',
          from: event.from,
          to: event.to,
          top: event.fromValue,
          bottom: event.toValue,
          color: eventColor,
          lineWidth: 2,
        });
        drawings.push({
          id: `rsi-${event.kind}-label-${event.to}`,
          kind: 'label',
          from: event.to,
          to: event.to,
          top: event.toValue,
          bottom: event.toValue,
          color: '#ffffff',
          labelBackground: eventColor,
          text: bull ? 'Bull' : 'Bear',
          align: bull ? 'below' : 'above',
          size: 'tiny',
        });
      }
    }
    const fills: IndicatorFill[] = [];
    if (parameters.showFills) {
      fills.push({ kind: 'band', top: 70, bottom: 30, color: `${color}1a` });
      const data = rsi.map((value, index) => ({
        index,
        upper: value,
        lower: value === undefined ? undefined : 50,
      }));
      fills.push({
        kind: 'area',
        data,
        color: bullColor,
        gradient: {
          top: 100,
          bottom: 70,
          topColor: bullColor,
          bottomColor: `${bullColor}00`,
        },
      });
      fills.push({
        kind: 'area',
        data,
        color: bearColor,
        gradient: {
          top: 30,
          bottom: 0,
          topColor: `${bearColor}00`,
          bottomColor: bearColor,
        },
      });
    }
    const plots: IndicatorPlot[] = [
      {
        id: 'rsi',
        type: 'line',
        title: `RSI ${parameters.rsiLength}`,
        color,
        lineWidth: Number(parameters.lineWidth) as 1 | 2 | 3 | 4,
        data: points(bars, rsi),
        referenceLines: [
          { value: 70, color: '#787b86' },
          { value: 50, color: '#787b8680' },
          { value: 30, color: '#787b86' },
        ],
        overlay: { drawings, fills, valueRange: { min: 0, max: 100 } },
      },
    ];
    const method = String(parameters.maType),
      length = Number(parameters.maLength);
    if (method !== 'none') {
      const average = smoothRsi(
        rsi,
        bars.map((bar) => bar.volume),
        length,
        method,
      );
      plots.push({
        id: 'average',
        type: 'line',
        title: `${method === 'sma-bb' ? 'SMA' : method.toUpperCase()} ${length}`,
        color: String(parameters.maColor),
        lineWidth: 1,
        data: points(bars, average),
      });
      if (method === 'sma-bb') {
        const deviation = rsiStandardDeviation(rsi, length);
        const band = (sign: number) =>
          average.map((value, index) =>
            value === undefined || deviation[index] === undefined
              ? undefined
              : value + sign * deviation[index]! * Number(parameters.bbMult),
          );
        const upper = band(1),
          lower = band(-1),
          bandColor = String(parameters.bandColor);
        plots.push({
          id: 'bb-upper',
          type: 'line',
          title: 'RSI BB 上轨',
          color: bandColor,
          lineWidth: 1,
          data: points(bars, upper),
        });
        plots.push({
          id: 'bb-lower',
          type: 'line',
          title: 'RSI BB 下轨',
          color: bandColor,
          lineWidth: 1,
          data: points(bars, lower),
        });
        if (parameters.showFills)
          fills.push({
            kind: 'area',
            color: `${bandColor}1a`,
            data: upper.map((value, index) => ({
              index,
              upper: value,
              lower: lower[index],
            })),
          });
      }
    }
    return plots;
  },
};
