// Adapted from ORB Algo | Flux Charts, © fluxchart, MPL-2.0.
// https://mozilla.org/MPL/2.0/
import type { IndicatorDefinition } from '../types';
import { movingAverage, points, priceValues } from '../calculations';
import { calculateOrb } from './orb/engine';
import { orbParameters, orbSettings } from './orb/settings';

export const orbIndicator: IndicatorDefinition = {
  id: 'orb',
  type: 'main',
  name: 'ORB Algo',
  description:
    '按 Flux Charts 原稿显示开盘区间、回踩确认的 Buy / Sell、TP 1–3、SL / Exit 及状态和模拟统计面板。默认 30 分钟区间、1 次回踩确认，仅支持不大于 15 分钟的分钟 K 线。基于已加载历史计算，末根 K 线信号盘中可能变化；原稿统计不是平台策略回测。',
  source: {
    name: 'Flux Charts · © fluxchart · MPL-2.0',
    url: 'https://mozilla.org/MPL/2.0/',
  },
  defaultVisible: false,
  requiresCandles: true,
  parameters: orbParameters,
  render: (bars, parameters) => {
    const settings = orbSettings(parameters);
    if (!settings.plotEMA || (bars[0] && bars[0].duration > 900)) return [];
    return [
      {
        id: 'ema',
        type: 'line',
        title: `ORB EMA ${settings.emaLength}`,
        color: '#2962ff',
        lineWidth: 1,
        data: points(
          bars,
          movingAverage(
            priceValues(bars, 'hl2'),
            Number(settings.emaLength),
            'ema',
          ),
        ),
      },
    ];
  },
  renderOverlay: (bars, parameters, duration) =>
    calculateOrb(bars, orbSettings(parameters), duration),
};
