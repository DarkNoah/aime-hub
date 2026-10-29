// Adapted from ORB Algo | Flux Charts, © fluxchart, MPL-2.0.
// https://mozilla.org/MPL/2.0/
import type { IndicatorParameter, IndicatorParameters } from '../../types';

const positions = [
  { value: 'top-right', label: '右上' },
  { value: 'right-center', label: '右侧中间' },
  { value: 'top-center', label: '顶部居中' },
] as const;

export const orbParameters = [
  {
    key: 'rangeMinutes',
    label: 'ORB 区间分钟数',
    type: 'number',
    default: 30,
    min: 1,
    integer: true,
    group: '算法',
    description: '按 K 线起始时间累计区间高低价；原稿默认 30 分钟。',
  },
  {
    key: 'sensitivity',
    label: '灵敏度',
    type: 'select',
    default: 'Medium',
    group: '算法',
    options: [
      { value: 'High', label: '高 · 无需回踩' },
      { value: 'Medium', label: '中 · 1 次回踩' },
      { value: 'Low', label: '低 · 2 次回踩' },
      { value: 'Lowest', label: '最低 · 3 次回踩' },
    ],
  },
  {
    key: 'breakoutCondition',
    label: '突破条件',
    type: 'select',
    default: 'Close',
    group: '算法',
    options: [
      { value: 'Close', label: '收盘价' },
      { value: 'EMA', label: 'EMA' },
    ],
  },
  {
    key: 'tpMethod',
    label: '止盈方式',
    type: 'select',
    default: 'Dynamic',
    group: '算法',
    options: [
      { value: 'Dynamic', label: '动态 · EMA 回撤' },
      { value: 'ATR', label: 'ATR · 0.75 / 1.5 / 2.25 倍' },
    ],
  },
  {
    key: 'emaLength',
    label: 'EMA 周期',
    type: 'select',
    default: '9',
    group: '算法',
    options: [4, 9, 13, 20, 34].map((value) => ({
      value: String(value),
      label: String(value),
    })),
  },
  {
    key: 'slMethod',
    label: '止损位置',
    type: 'select',
    default: 'Balanced',
    group: '算法',
    options: [
      { value: 'Safer', label: 'Safer · 靠近突破侧' },
      { value: 'Balanced', label: 'Balanced · 区间中点' },
      { value: 'Risky', label: 'Risky · 靠近另一侧' },
    ],
  },
  {
    key: 'adaptiveSL',
    label: '自适应止损',
    type: 'boolean',
    default: true,
    group: '算法',
    description: 'TP 1 后将止损移到入场价；同根 K 线优先处理止盈。',
  },
  {
    key: 'regularSessionStart',
    label: '常规开盘时间',
    type: 'time',
    default: '09:30',
    group: '交易时段',
    description:
      '北京时间，替代 TradingView 的交易所常规开盘标志。股指 / 股票默认 09:30；商品日盘请设为 09:00。须加载开盘首根 K 线。',
  },
  {
    key: 'customSessionEnabled',
    label: '启用自定义时段',
    type: 'boolean',
    default: false,
    group: '交易时段',
  },
  {
    key: 'customSessionStart',
    label: '自定义开始时间',
    type: 'time',
    default: '10:00',
    group: '交易时段',
  },
  {
    key: 'customSessionEnd',
    label: '自定义结束时间',
    type: 'time',
    default: '11:00',
    group: '交易时段',
    description:
      '早于开始时间时跨至次日。与原稿一致，此时段只确定新 ORB 的起点，区间和交易持续到下一次起点。',
  },
  {
    key: 'orbDisplayEnabled',
    label: '显示 ORB 状态面板',
    type: 'boolean',
    default: true,
    group: '面板',
  },
  {
    key: 'orbLocation',
    label: '状态面板位置',
    type: 'select',
    default: 'top-right',
    options: positions,
    group: '面板',
  },
  {
    key: 'backtestDisplayEnabled',
    label: '显示原稿模拟统计',
    type: 'boolean',
    default: true,
    group: '面板',
  },
  {
    key: 'backtestingLocation',
    label: '模拟统计位置',
    type: 'select',
    default: 'top-center',
    options: positions,
    group: '面板',
  },
  {
    key: 'backtestingExitRatios',
    label: '分批止盈比例',
    type: 'select',
    default: '90% | 5% | 5%',
    group: '面板',
    description:
      'TP 1 / TP 2 / TP 3。原稿简化统计不计费用、滑点或真实成交；触及过 TP 即计为胜。',
    options: [
      '75% | 15% | 10%',
      '50% | 25% | 25%',
      '34% | 33% | 33%',
      '90% | 5% | 5%',
      '100% | 0% | 0%',
      '0% | 100% | 0%',
      '0% | 0% | 100%',
    ].map((value) => ({ value, label: value })),
  },
  {
    key: 'showORBZones',
    label: '显示 ORB 上下沿',
    type: 'boolean',
    default: true,
    group: '显示样式',
  },
  {
    key: 'plotEMA',
    label: '显示 EMA',
    type: 'boolean',
    default: false,
    group: '显示样式',
  },
  {
    key: 'showHistoricZones',
    label: '显示历史时段',
    type: 'boolean',
    default: true,
    group: '显示样式',
    description:
      '最多绘制最近 5,000 根 K 线内的区域与标记；计算和统计保留全部已加载历史。',
  },
  {
    key: 'highColor',
    label: '上沿颜色',
    type: 'color',
    default: '#4caf50',
    group: '显示样式',
  },
  {
    key: 'lowColor',
    label: '下沿颜色',
    type: 'color',
    default: '#f23645',
    group: '显示样式',
  },
] as const satisfies readonly IndicatorParameter[];

export interface OrbSettings {
  rangeMinutes: number;
  sensitivity: 'High' | 'Medium' | 'Low' | 'Lowest';
  breakoutCondition: 'Close' | 'EMA';
  tpMethod: 'Dynamic' | 'ATR';
  emaLength: string;
  slMethod: 'Safer' | 'Balanced' | 'Risky';
  adaptiveSL: boolean;
  regularSessionStart: string;
  customSessionEnabled: boolean;
  customSessionStart: string;
  customSessionEnd: string;
  orbDisplayEnabled: boolean;
  orbLocation: 'top-right' | 'right-center' | 'top-center';
  backtestDisplayEnabled: boolean;
  backtestingLocation: 'top-right' | 'right-center' | 'top-center';
  backtestingExitRatios: string;
  showORBZones: boolean;
  plotEMA: boolean;
  showHistoricZones: boolean;
  highColor: string;
  lowColor: string;
}

export function orbSettings(parameters: IndicatorParameters): OrbSettings {
  return Object.fromEntries(
    orbParameters.map((field) => [
      field.key,
      parameters[field.key] ?? field.default,
    ]),
  ) as unknown as OrbSettings;
}

export function timeMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}
