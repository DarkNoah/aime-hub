import {
  averageOptions,
  movingAverage,
  points,
  priceSourceParameter,
  priceValues,
} from '../calculations';
import type { IndicatorDefinition } from '../types';

export const maIndicator: IndicatorDefinition = {
  id: 'ma',
  type: 'main',
  name: 'MA 均线',
  description: '在价格主图叠加移动平均线，可切换 SMA 或 EMA。',
  source: {
    name: 'TradingView · Moving Average',
    url: 'https://www.tradingview.com/support/solutions/43000502589-moving-average/',
  },
  defaultVisible: true,
  priceFormat: 'price',
  parameters: [
    {
      key: 'period',
      label: '周期',
      type: 'number',
      default: 20,
      min: 1,
      integer: true,
    },
    {
      key: 'method',
      label: '均线类型',
      type: 'select',
      default: 'sma',
      options: averageOptions,
    },
    priceSourceParameter,
    { key: 'color', label: '线条颜色', type: 'color', default: '#d18b22' },
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
    return [
      {
        id: 'average',
        type: 'line',
        title: `${String(parameters.method).toUpperCase()} ${parameters.period}`,
        color: String(parameters.color),
        lineWidth: Number(parameters.lineWidth) as 1 | 2 | 3 | 4,
        data: points(
          bars,
          movingAverage(
            priceValues(bars, String(parameters.priceSource)),
            Number(parameters.period),
            String(parameters.method),
          ),
        ),
      },
    ];
  },
};
