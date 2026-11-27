export const optionMode = 'time_value_third' as const;
export type OptionMode = typeof optionMode;
export const optionModeName = '三分之一时间价值';

export function optionSelectionLabel(value: { mode?: OptionMode }) {
  return value.mode === optionMode ? optionModeName : '历史选约规则';
}
