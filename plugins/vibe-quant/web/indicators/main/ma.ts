import {
  averageOptions,
  movingAverage,
  points,
  priceSourceParameter,
  priceValues,
} from '../calculations';
import type { IndicatorDefinition, IndicatorParameter } from '../types';

// Keep the original single-line keys on the third slot so saved settings survive.
const SLOTS = [
  {
    period: 'period1',
    color: 'color1',
    id: 'average1',
    default: 5,
    defaultColor: '#3b82f6',
  },
  {
    period: 'period2',
    color: 'color2',
    id: 'average2',
    default: 10,
    defaultColor: '#a855f7',
  },
  {
    period: 'period',
    color: 'color',
    id: 'average',
    default: 20,
    defaultColor: '#d18b22',
  },
] as const;

export const maIndicator: IndicatorDefinition = {
  id: 'ma',
  type: 'main',
  name: 'MA 均线',
  description:
    '在主图叠加三条均线，默认周期 5 / 10 / 20，可分别设置周期和颜色，共用 SMA / EMA 类型与价格来源。',
  source: {
    name: 'TradingView · Moving Average',
    url: 'https://www.tradingview.com/support/solutions/43000502589-moving-average/',
  },
  defaultVisible: true,
  priceFormat: 'price',
  parameters: [
    ...SLOTS.flatMap((slot, index): IndicatorParameter[] => [
      {
        key: slot.period,
        label: `周期 ${index + 1}`,
        type: 'number',
        default: slot.default,
        min: 1,
        integer: true,
      },
      {
        key: slot.color,
        label: `颜色 ${index + 1}`,
        type: 'color',
        default: slot.defaultColor,
      },
    ]),
    {
      key: 'method',
      label: '均线类型',
      type: 'select',
      default: 'sma',
      options: averageOptions,
    },
    priceSourceParameter,
    {
      key: 'lineWidth',
      label: '线宽',
      type: 'number',
      default: 2,
      min: 1,
      max: 4,
      integer: true,
    },
  ],
  render(bars, parameters) {
    const values = priceValues(bars, String(parameters.priceSource));
    return SLOTS.map((slot) => ({
      id: slot.id,
      type: 'line',
      title: `${String(parameters.method).toUpperCase()} ${parameters[slot.period]}`,
      color: String(parameters[slot.color]),
      lineWidth: Number(parameters.lineWidth) as 1 | 2 | 3 | 4,
      data: points(
        bars,
        movingAverage(
          values,
          Number(parameters[slot.period]),
          String(parameters.method),
        ),
      ),
    }));
  },
};
