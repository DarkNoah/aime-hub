// Port of Smart Money Concepts [LuxAlgo], © LuxAlgo, CC BY-NC-SA 4.0.
// https://creativecommons.org/licenses/by-nc-sa/4.0/
export type Field = {
  group: string;
  label: string;
  value: string | number | boolean;
  options?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
};
const field = <T extends string | number | boolean>(
  group: string,
  label: string,
  value: T,
  extra: Omit<Field, 'group' | 'label' | 'value'> = {},
) => ({ group, label, value, ...extra });
const structure = { options: ['All', 'BOS', 'CHoCH'] };
const size = { options: ['tiny', 'small', 'normal'] };
const line = { options: ['solid', 'dashed', 'dotted'] };
export const SMC_FIELDS = {
  modeInput: field('Smart Money Concepts', 'Mode', 'Historical', {
    options: ['Historical', 'Present'],
  }),
  styleInput: field('Smart Money Concepts', 'Style', 'Colored', {
    options: ['Colored', 'Monochrome'],
  }),
  showTrendInput: field('Smart Money Concepts', 'Color Candles', false),
  showInternalsInput: field(
    'Real Time Internal Structure',
    'Show Internal Structure',
    true,
  ),
  showInternalBullInput: field(
    'Real Time Internal Structure',
    'Bullish Structure',
    'All',
    structure,
  ),
  internalBullColorInput: field(
    'Real Time Internal Structure',
    'Bullish Color',
    '#089981',
  ),
  showInternalBearInput: field(
    'Real Time Internal Structure',
    'Bearish Structure',
    'All',
    structure,
  ),
  internalBearColorInput: field(
    'Real Time Internal Structure',
    'Bearish Color',
    '#F23645',
  ),
  internalFilterConfluenceInput: field(
    'Real Time Internal Structure',
    'Confluence Filter',
    false,
  ),
  internalStructureSize: field(
    'Real Time Internal Structure',
    'Internal Label Size',
    'tiny',
    size,
  ),
  showStructureInput: field(
    'Real Time Swing Structure',
    'Show Swing Structure',
    true,
  ),
  showSwingBullInput: field(
    'Real Time Swing Structure',
    'Bullish Structure',
    'All',
    structure,
  ),
  swingBullColorInput: field(
    'Real Time Swing Structure',
    'Bullish Color',
    '#089981',
  ),
  showSwingBearInput: field(
    'Real Time Swing Structure',
    'Bearish Structure',
    'All',
    structure,
  ),
  swingBearColorInput: field(
    'Real Time Swing Structure',
    'Bearish Color',
    '#F23645',
  ),
  swingStructureSize: field(
    'Real Time Swing Structure',
    'Swing Label Size',
    'small',
    size,
  ),
  showSwingsInput: field(
    'Real Time Swing Structure',
    'Show Swings Points',
    false,
  ),
  swingsLengthInput: field('Real Time Swing Structure', 'Swings Length', 50, {
    min: 10,
    step: 1,
  }),
  showHighLowSwingsInput: field(
    'Real Time Swing Structure',
    'Show Strong/Weak High/Low',
    true,
  ),
  showInternalOrderBlocksInput: field(
    'Order Blocks',
    'Internal Order Blocks',
    true,
  ),
  internalOrderBlocksSizeInput: field('Order Blocks', 'Internal OB Count', 5, {
    min: 1,
    max: 20,
    step: 1,
  }),
  showSwingOrderBlocksInput: field('Order Blocks', 'Swing Order Blocks', false),
  swingOrderBlocksSizeInput: field('Order Blocks', 'Swing OB Count', 5, {
    min: 1,
    max: 20,
    step: 1,
  }),
  orderBlockFilterInput: field('Order Blocks', 'Order Block Filter', 'Atr', {
    options: ['Atr', 'Cumulative Mean Range'],
  }),
  orderBlockMitigationInput: field(
    'Order Blocks',
    'Order Block Mitigation',
    'High/Low',
    { options: ['Close', 'High/Low'] },
  ),
  internalBullishOrderBlockColor: field(
    'Order Blocks',
    'Internal Bullish OB',
    '#3179f533',
  ),
  internalBearishOrderBlockColor: field(
    'Order Blocks',
    'Internal Bearish OB',
    '#f77c8033',
  ),
  swingBullishOrderBlockColor: field('Order Blocks', 'Bullish OB', '#1848cc33'),
  swingBearishOrderBlockColor: field('Order Blocks', 'Bearish OB', '#b2283333'),
  showEqualHighsLowsInput: field('EQH/EQL', 'Equal High/Low', true),
  equalHighsLowsLengthInput: field('EQH/EQL', 'Bars Confirmation', 3, {
    min: 1,
    step: 1,
  }),
  equalHighsLowsThresholdInput: field('EQH/EQL', 'Threshold', 0.1, {
    min: 0,
    max: 0.5,
    step: 0.1,
  }),
  equalHighsLowsSizeInput: field('EQH/EQL', 'Label Size', 'tiny', size),
  showFairValueGapsInput: field('Fair Value Gaps', 'Fair Value Gaps', false),
  fairValueGapsThresholdInput: field('Fair Value Gaps', 'Auto Threshold', true),
  fairValueGapsTimeframeInput: field('Fair Value Gaps', 'Timeframe', '', {
    options: ['', '1m', '3m', '5m', '15m', '30m', '60m', '1d', '1w', '1M'],
  }),
  fairValueGapsBullColorInput: field(
    'Fair Value Gaps',
    'Bullish FVG',
    '#00ff684d',
  ),
  fairValueGapsBearColorInput: field(
    'Fair Value Gaps',
    'Bearish FVG',
    '#ff00084d',
  ),
  fairValueGapsExtendInput: field('Fair Value Gaps', 'Extend FVG', 1, {
    min: 0,
    step: 1,
  }),
  showDailyLevelsInput: field('Highs & Lows MTF', 'Daily', false),
  dailyLevelsStyleInput: field(
    'Highs & Lows MTF',
    'Daily Style',
    'solid',
    line,
  ),
  dailyLevelsColorInput: field('Highs & Lows MTF', 'Daily Color', '#2157f3'),
  showWeeklyLevelsInput: field('Highs & Lows MTF', 'Weekly', false),
  weeklyLevelsStyleInput: field(
    'Highs & Lows MTF',
    'Weekly Style',
    'solid',
    line,
  ),
  weeklyLevelsColorInput: field('Highs & Lows MTF', 'Weekly Color', '#2157f3'),
  showMonthlyLevelsInput: field('Highs & Lows MTF', 'Monthly', false),
  monthlyLevelsStyleInput: field(
    'Highs & Lows MTF',
    'Monthly Style',
    'solid',
    line,
  ),
  monthlyLevelsColorInput: field(
    'Highs & Lows MTF',
    'Monthly Color',
    '#2157f3',
  ),
  showPremiumDiscountZonesInput: field(
    'Premium & Discount Zones',
    'Premium/Discount Zones',
    false,
  ),
  premiumZoneColorInput: field(
    'Premium & Discount Zones',
    'Premium Zone',
    '#F23645',
  ),
  equilibriumZoneColorInput: field(
    'Premium & Discount Zones',
    'Equilibrium Zone',
    '#878b94',
  ),
  discountZoneColorInput: field(
    'Premium & Discount Zones',
    'Discount Zone',
    '#089981',
  ),
} satisfies Record<string, Field>;
export type SmcSettings = {
  [
    K in keyof typeof SMC_FIELDS
  ]: (typeof SMC_FIELDS)[K]['value'] extends boolean
    ? boolean
    : (typeof SMC_FIELDS)[K]['value'] extends number
      ? number
      : string;
};
export const DEFAULT_SMC_SETTINGS = Object.fromEntries(
  Object.entries(SMC_FIELDS).map(([key, field]) => [key, field.value]),
) as SmcSettings;
export function normalizeSmcSettings(input: Partial<SmcSettings>): SmcSettings {
  return Object.fromEntries(
    Object.entries(SMC_FIELDS).map(([key, field]) => {
      const value = input[key as keyof SmcSettings];
      if (typeof value !== typeof field.value) return [key, field.value];
      if (typeof value === 'number')
        return [
          key,
          Number.isFinite(value)
            ? Math.max(
                field.min ?? -Infinity,
                Math.min(
                  field.max ?? Infinity,
                  field.step === 1 ? Math.round(value) : value,
                ),
              )
            : field.value,
        ];
      if (
        typeof value === 'string' &&
        (field.options
          ? !field.options.includes(value)
          : !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value))
      )
        return [key, field.value];
      return [key, value];
    }),
  ) as SmcSettings;
}
