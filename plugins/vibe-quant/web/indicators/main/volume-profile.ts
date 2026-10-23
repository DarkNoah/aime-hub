import { PROFILE_RANGES } from '../../../volume-profile';
import type { IndicatorDefinition } from '../types';
import { volumeProfileOverlay } from './volume-profile/overlay';

export const volumeProfileIndicator: IndicatorDefinition = {
  id: 'volumeProfile',
  type: 'main',
  name: '成交量分布',
  defaultVisible: false,
  requiresCandles: true,
  description:
    '按固定北京时间区间显示通达信分笔的价格成交量、POC、VAH / VAL 和 VWAP。价值区间内买入红色、卖出绿色、中性灰色，区间外浅灰色，与 stock-rl 一致。行情分笔并非交易所完整逐笔；缺失区间不绘制，历史整段分布仅供复盘。',
  source: { name: 'stock-rl · 通达信分笔成交' },
  parameters: [
    {
      key: 'rowSize',
      type: 'number',
      group: '计算',
      label: '价格档数 Row Size',
      default: 30,
      min: 2,
      max: 200,
      integer: true,
      step: 1,
    },
    {
      key: 'valueAreaVolume',
      type: 'number',
      group: '计算',
      label: '价值区域成交量（%）',
      default: 70,
      min: 1,
      max: 100,
      step: 1,
    },
    {
      key: 'range',
      type: 'select',
      group: '范围',
      label: '固定范围',
      default: '1d',
      options: Object.keys(PROFILE_RANGES).map((value) => ({
        value,
        label: value
          .replace('m', ' 分钟')
          .replace('h', ' 小时')
          .replace('d', ' 天'),
      })),
    },
    {
      key: 'showCurrent',
      type: 'boolean',
      group: '范围',
      label: '显示当前未完成区间',
      default: false,
    },
  ],
  render: () => [],
  renderOverlay: (bars, parameters, duration, context) =>
    volumeProfileOverlay(bars, parameters, duration, context?.volumeProfile),
};
