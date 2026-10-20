import {
  averageOptions,
  movingAverage,
  points,
  priceSourceParameter,
  priceValues,
} from '../calculations';
import type { IndicatorDefinition } from '../types';

export const macdIndicator: IndicatorDefinition = {
  id: 'macd',
  type: 'sub',
  name: 'MACD',
  description: '快慢均线差值、信号线及柱状图。柱值 = MACD − Signal，不乘以 2。',
  source: {
    name: 'TradingView · MACD',
    url: 'https://www.tradingview.com/support/solutions/43000502344-moving-average-convergence-divergence-macd-indicator/',
  },
  defaultVisible: true,
  priceFormat: 'oscillator',
  parameters: [
    {
      key: 'fastPeriod',
      label: '快线周期',
      type: 'number',
      default: 12,
      min: 1,
      integer: true,
    },
    {
      key: 'slowPeriod',
      label: '慢线周期',
      type: 'number',
      default: 26,
      min: 1,
      integer: true,
    },
    {
      key: 'signalPeriod',
      label: '信号周期',
      type: 'number',
      default: 9,
      min: 1,
      integer: true,
    },
    priceSourceParameter,
    {
      key: 'method',
      label: '快慢均线类型',
      type: 'select',
      default: 'ema',
      options: averageOptions,
    },
    {
      key: 'signalMethod',
      label: '信号均线类型',
      type: 'select',
      default: 'ema',
      options: averageOptions,
    },
    {
      key: 'macdColor',
      label: 'MACD 线颜色',
      type: 'color',
      default: '#3874d8',
    },
    {
      key: 'signalColor',
      label: '信号线颜色',
      type: 'color',
      default: '#d18b22',
    },
    {
      key: 'positiveColor',
      label: '正值柱颜色',
      type: 'color',
      default: '#248659',
    },
    {
      key: 'negativeColor',
      label: '负值柱颜色',
      type: 'color',
      default: '#cc3e4d',
    },
  ],
  validate: (parameters) =>
    Number(parameters.fastPeriod) >= Number(parameters.slowPeriod)
      ? '快线周期必须小于慢线周期'
      : undefined,
  render(bars, parameters) {
    const prices = priceValues(bars, String(parameters.priceSource));
    const fast = movingAverage(
      prices,
      Number(parameters.fastPeriod),
      String(parameters.method),
    );
    const slow = movingAverage(
      prices,
      Number(parameters.slowPeriod),
      String(parameters.method),
    );
    const macd = fast.map((value, index) =>
      value === undefined || slow[index] === undefined
        ? undefined
        : value - slow[index]!,
    );
    const signal = movingAverage(
      macd,
      Number(parameters.signalPeriod),
      String(parameters.signalMethod),
    );
    const histogram = macd.map((value, index) =>
      value === undefined || signal[index] === undefined
        ? undefined
        : value - signal[index]!,
    );
    return [
      {
        id: 'histogram',
        type: 'histogram',
        title: 'MACD 柱',
        color: String(parameters.positiveColor),
        data: points(bars, histogram).map((point) =>
          point.value === undefined
            ? point
            : {
                ...point,
                color: String(
                  point.value >= 0
                    ? parameters.positiveColor
                    : parameters.negativeColor,
                ),
              },
        ),
      },
      {
        id: 'macd',
        type: 'line',
        title: `MACD (${parameters.fastPeriod}, ${parameters.slowPeriod})`,
        color: String(parameters.macdColor),
        lineWidth: 2,
        zeroLine: true,
        data: points(bars, macd),
      },
      {
        id: 'signal',
        type: 'line',
        title: `Signal ${parameters.signalPeriod}`,
        color: String(parameters.signalColor),
        lineWidth: 2,
        data: points(bars, signal),
      },
    ];
  },
};
