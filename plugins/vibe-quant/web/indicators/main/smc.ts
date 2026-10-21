// Adapted from stock-rl's Smart Money Concepts port, © LuxAlgo, CC BY-NC-SA 4.0.
import type {
  IndicatorDefinition,
  IndicatorParameter,
  IndicatorParameters,
} from '../types';
import { calculateSmc } from './smc/engine';
import { SMC_FIELDS, type Field, type SmcSettings } from './smc/settings';

const groups: Record<string, string> = {
  'Smart Money Concepts': '基础设置',
  'Real Time Internal Structure': '内部结构',
  'Real Time Swing Structure': '波段结构',
  'Order Blocks': '订单块',
  'EQH/EQL': '等高 / 等低点',
  'Fair Value Gaps': '公允价值缺口 FVG',
  'Highs & Lows MTF': '多周期高低点',
  'Premium & Discount Zones': '溢价 / 折价区',
};
const labels: Record<keyof SmcSettings, string> = {
  modeInput: '显示模式',
  styleInput: '配色模式',
  showTrendInput: '趋势蜡烛颜色',
  showInternalsInput: '显示内部结构',
  showInternalBullInput: '内部多头结构',
  internalBullColorInput: '内部多头颜色',
  showInternalBearInput: '内部空头结构',
  internalBearColorInput: '内部空头颜色',
  internalFilterConfluenceInput: '合流过滤',
  internalStructureSize: '内部标签字号',
  showStructureInput: '显示波段结构',
  showSwingBullInput: '波段多头结构',
  swingBullColorInput: '波段多头颜色',
  showSwingBearInput: '波段空头结构',
  swingBearColorInput: '波段空头颜色',
  swingStructureSize: '波段标签字号',
  showSwingsInput: '显示 HH / HL / LH / LL',
  swingsLengthInput: '波段确认长度',
  showHighLowSwingsInput: '显示强弱高低点',
  showInternalOrderBlocksInput: '显示内部订单块',
  internalOrderBlocksSizeInput: '内部订单块数量',
  showSwingOrderBlocksInput: '显示波段订单块',
  swingOrderBlocksSizeInput: '波段订单块数量',
  orderBlockFilterInput: '订单块波动过滤',
  orderBlockMitigationInput: '订单块失效依据',
  internalBullishOrderBlockColor: '内部多头订单块',
  internalBearishOrderBlockColor: '内部空头订单块',
  swingBullishOrderBlockColor: '波段多头订单块',
  swingBearishOrderBlockColor: '波段空头订单块',
  showEqualHighsLowsInput: '显示 EQH / EQL',
  equalHighsLowsLengthInput: '等高低点确认长度',
  equalHighsLowsThresholdInput: '等高低点阈值',
  equalHighsLowsSizeInput: '等高低点标签字号',
  showFairValueGapsInput: '显示 FVG',
  fairValueGapsThresholdInput: '自动阈值',
  fairValueGapsTimeframeInput: 'FVG 周期',
  fairValueGapsBullColorInput: '多头 FVG 颜色',
  fairValueGapsBearColorInput: '空头 FVG 颜色',
  fairValueGapsExtendInput: 'FVG 延长根数',
  showDailyLevelsInput: '显示日高低点',
  dailyLevelsStyleInput: '日高低点线型',
  dailyLevelsColorInput: '日高低点颜色',
  showWeeklyLevelsInput: '显示周高低点',
  weeklyLevelsStyleInput: '周高低点线型',
  weeklyLevelsColorInput: '周高低点颜色',
  showMonthlyLevelsInput: '显示月高低点',
  monthlyLevelsStyleInput: '月高低点线型',
  monthlyLevelsColorInput: '月高低点颜色',
  showPremiumDiscountZonesInput: '显示溢价 / 折价区',
  premiumZoneColorInput: '溢价区颜色',
  equilibriumZoneColorInput: '均衡区颜色',
  discountZoneColorInput: '折价区颜色',
};
const optionLabels: Record<string, string> = {
  Historical: '历史结构',
  Present: '最近结构',
  Colored: '彩色',
  Monochrome: '单色',
  All: '全部',
  tiny: '小',
  small: '中',
  normal: '大',
  solid: '实线',
  dashed: '虚线',
  dotted: '点线',
  Atr: 'ATR (200)',
  'Cumulative Mean Range': '累计平均波幅',
  Close: '收盘价',
  'High/Low': '最高 / 最低价',
  '1m': '1 分钟',
  '3m': '3 分钟',
  '5m': '5 分钟',
  '15m': '15 分钟',
  '30m': '30 分钟',
  '60m': '60 分钟',
  '1d': '日线',
  '1w': '周线',
  '1M': '月线',
};
const timeframes: Record<number, string> = {
  60: '1m',
  180: '3m',
  300: '5m',
  900: '15m',
  1800: '30m',
  3600: '60m',
  86400: '1d',
  2592000: '1M',
};

export function smcSettings(
  parameters: IndicatorParameters,
): Partial<SmcSettings> {
  return {
    ...parameters,
    fairValueGapsTimeframeInput:
      parameters.fairValueGapsTimeframeInput === 'current'
        ? ''
        : String(parameters.fairValueGapsTimeframeInput ?? ''),
  };
}

export const smcIndicator: IndicatorDefinition = {
  id: 'smc',
  type: 'main',
  name: 'SMC 智能资金',
  description:
    '显示内部 / 波段 BOS、CHoCH、订单块、EQH/EQL、FVG 与溢价折价区。基于已加载 K 线计算，盘中信号随行情更新。',
  source: {
    name: 'LuxAlgo · stock-rl 移植 · CC BY-NC-SA 4.0',
    url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  },
  defaultVisible: true,
  requiresCandles: true,
  parameters: Object.entries(SMC_FIELDS).map(
    ([key, value]): IndicatorParameter => {
      const field: Field = value;
      const base = {
        key,
        label: labels[key as keyof SmcSettings],
        group: groups[field.group],
      };
      if (typeof field.value === 'boolean')
        return { ...base, type: 'boolean', default: field.value };
      if (typeof field.value === 'number')
        return {
          ...base,
          type: 'number',
          default: field.value,
          min: field.min,
          max: field.max,
          step: field.step,
          integer: field.step === 1,
        };
      if (field.options)
        return {
          ...base,
          type: 'select',
          default: field.value || 'current',
          options: field.options.map((value) => ({
            value: value || 'current',
            label: value ? (optionLabels[value] ?? value) : '当前图表周期',
          })),
        };
      return {
        ...base,
        type: 'color',
        default: field.value,
        alpha: field.value.length === 9,
      };
    },
  ),
  render: () => [],
  renderOverlay(bars, parameters, duration) {
    if (!timeframes[duration])
      return { drawings: [], warnings: ['SMC 暂不支持当前周期。'] };
    return calculateSmc(bars, smcSettings(parameters), timeframes[duration]);
  },
};
