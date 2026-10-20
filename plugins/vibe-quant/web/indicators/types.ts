import type { Bar } from '../../shared';

export type IndicatorType = 'main' | 'sub';
export type IndicatorValue = string | number | boolean;
export type IndicatorParameters = Record<string, IndicatorValue>;

interface ParameterBase {
  key: string;
  label: string;
  description?: string;
}

export type IndicatorParameter =
  | (ParameterBase & {
      type: 'number';
      default: number;
      min?: number;
      max?: number;
      integer?: boolean;
      step?: number;
    })
  | (ParameterBase & {
      type: 'select';
      default: string;
      options: readonly { value: string; label: string }[];
    })
  | (ParameterBase & { type: 'color'; default: string })
  | (ParameterBase & { type: 'boolean'; default: boolean });

/** A missing value is a warm-up/whitespace point, never a fabricated zero. */
export interface IndicatorPoint {
  time: number;
  value?: number;
  color?: string;
}

/** Scripts own both their calculation and display style; the host owns series. */
export interface IndicatorPlot {
  id: string;
  type: 'line' | 'histogram';
  title: string;
  color: string;
  lineWidth?: 1 | 2 | 3 | 4;
  data: IndicatorPoint[];
  zeroLine?: boolean;
}

export interface IndicatorDefinition {
  id: string;
  type: IndicatorType;
  name: string;
  description: string;
  source?: { name: string; url?: string };
  parameters: readonly IndicatorParameter[];
  defaultVisible: boolean;
  priceFormat?: 'price' | 'volume' | 'oscillator';
  paneWeight?: number;
  validate?: (parameters: IndicatorParameters) => string | undefined;
  render: (
    bars: readonly Bar[],
    parameters: IndicatorParameters,
  ) => IndicatorPlot[];
}

export interface IndicatorPreference {
  visible: boolean;
  parameters: IndicatorParameters;
}

export type IndicatorPreferences = Record<string, IndicatorPreference>;
