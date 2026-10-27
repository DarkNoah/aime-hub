// Adapted from “Support and Resistance Logistic Regression | Flux Charts”.
// © fluxchart. MPL-2.0: https://mozilla.org/MPL/2.0/
import type { IndicatorParameter, IndicatorParameters } from '../../types';

export const logisticSrParameters = [
  {
    key: 'pivotLength',
    label: '拐点确认长度',
    type: 'number',
    default: 14,
    min: 1,
    integer: true,
    group: '基础设置',
    description: '左右各需此数量的 K 线确认拐点；RSI 和 ATR 使用相同周期。',
  },
  {
    key: 'targetRespects',
    label: '目标有效触碰次数',
    type: 'number',
    default: 3,
    min: 1,
    integer: true,
    group: '基础设置',
    description: '影线穿过价位后收回才计数，用于回归模型的训练标签。',
  },
  {
    key: 'probabilityThreshold',
    label: '概率阈值',
    type: 'number',
    default: 0.7,
    min: 0.001,
    max: 1,
    step: 0.05,
    group: '基础设置',
    description: '仅显示预测值不低于此阈值的支撑 / 阻力线（0–1）。',
  },
  {
    key: 'hideFarLines',
    label: '隐藏远离价格的线',
    type: 'boolean',
    default: true,
    group: '基础设置',
    description: '隐藏距最新收盘价超过 7 倍 ATR 的未突破价位。',
  },
  {
    key: 'showPredictionLabels',
    label: '显示预测概率',
    type: 'boolean',
    default: true,
    group: '显示样式',
  },
  {
    key: 'showRetests',
    label: '显示有效触碰 R',
    type: 'boolean',
    default: false,
    group: '显示样式',
  },
  {
    key: 'showBreaks',
    label: '显示突破 B',
    type: 'boolean',
    default: false,
    group: '显示样式',
  },
  {
    key: 'lineStyle',
    label: '线型',
    type: 'select',
    default: 'solid',
    options: [
      { value: 'solid', label: '实线' },
      { value: 'dashed', label: '虚线' },
      { value: 'dotted', label: '点线' },
    ],
    group: '显示样式',
  },
  {
    key: 'lineWidth',
    label: '线宽',
    type: 'number',
    default: 3,
    min: 1,
    max: 3,
    integer: true,
    group: '显示样式',
  },
  {
    key: 'supportColor',
    label: '支撑线 / 标签颜色',
    type: 'color',
    default: '#089981',
    group: '颜色',
  },
  {
    key: 'resistanceColor',
    label: '阻力线 / 标签颜色',
    type: 'color',
    default: '#f23645',
    group: '颜色',
  },
  {
    key: 'textColorSupport',
    label: '支撑触碰文字颜色',
    type: 'color',
    default: '#ffffff',
    group: '颜色',
  },
  {
    key: 'textColorResistance',
    label: '阻力触碰文字颜色',
    type: 'color',
    default: '#ffffff',
    group: '颜色',
  },
] as const satisfies readonly IndicatorParameter[];

export interface LogisticSrSettings {
  pivotLength: number;
  targetRespects: number;
  probabilityThreshold: number;
  hideFarLines: boolean;
  showPredictionLabels: boolean;
  showRetests: boolean;
  showBreaks: boolean;
  lineStyle: string;
  lineWidth: number;
  supportColor: string;
  resistanceColor: string;
  textColorSupport: string;
  textColorResistance: string;
}

export function logisticSrSettings(
  parameters: IndicatorParameters,
): LogisticSrSettings {
  return Object.fromEntries(
    logisticSrParameters.map((field) => [
      field.key,
      parameters[field.key] ?? field.default,
    ]),
  ) as unknown as LogisticSrSettings;
}
