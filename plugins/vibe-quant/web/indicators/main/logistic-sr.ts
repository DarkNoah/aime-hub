// Adapted from the user-supplied Pine Script, © fluxchart, MPL-2.0.
// https://mozilla.org/MPL/2.0/
import type { IndicatorDefinition } from '../types';
import { calculateLogisticSr } from './logistic-sr/engine';
import {
  logisticSrParameters,
  logisticSrSettings,
} from './logistic-sr/settings';

export const logisticSrIndicator: IndicatorDefinition = {
  id: 'logisticSr',
  type: 'main',
  name: '逻辑回归支撑阻力',
  description:
    '按 Flux Charts 原脚本，以 RSI、实体大小及有效触碰次数筛选支撑 / 阻力，支持概率、触碰 R 和突破 B 标记。拐点确认后回画至起点；基于已加载历史计算，盘中末根 K 线信号可能变化，概率不代表交易胜率。',
  source: {
    name: 'Flux Charts · © fluxchart · MPL-2.0',
    url: 'https://mozilla.org/MPL/2.0/',
  },
  defaultVisible: false,
  requiresCandles: true,
  parameters: logisticSrParameters,
  render: () => [],
  renderOverlay: (bars, parameters) =>
    calculateLogisticSr(bars, logisticSrSettings(parameters)),
};
