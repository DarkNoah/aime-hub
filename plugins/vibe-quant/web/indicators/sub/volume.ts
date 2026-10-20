import type { IndicatorDefinition } from '../types';

export const volumeIndicator: IndicatorDefinition = {
  id: 'volume',
  type: 'sub',
  name: 'VOL 成交量',
  description: '每根 K 线的成交量，沿用行情源提供的单位。',
  defaultVisible: true,
  priceFormat: 'volume',
  paneWeight: 0.75,
  parameters: [
    { key: 'upColor', label: '上涨柱颜色', type: 'color', default: '#cc3e4d' },
    {
      key: 'downColor',
      label: '下跌柱颜色',
      type: 'color',
      default: '#248659',
    },
  ],
  render: (bars, parameters) => [
    {
      id: 'volume',
      type: 'histogram',
      title: 'VOL',
      color: String(parameters.upColor),
      data: bars.map((bar) => ({
        time: bar.time,
        value: bar.volume,
        color: String(
          bar.close >= bar.open ? parameters.upColor : parameters.downColor,
        ),
      })),
    },
  ],
};
