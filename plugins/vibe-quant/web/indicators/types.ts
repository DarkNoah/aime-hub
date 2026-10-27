import type { Bar } from '../../shared';
import type { VolumeProfileData } from '../../volume-profile';

export interface IndicatorContext {
  volumeProfile?: VolumeProfileData;
}

export type IndicatorType = 'main' | 'sub';
export type IndicatorValue = string | number | boolean;
export type IndicatorParameters = Record<string, IndicatorValue>;

interface ParameterBase {
  key: string;
  label: string;
  description?: string;
  group?: string;
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
  | (ParameterBase & { type: 'color'; default: string; alpha?: boolean })
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
  referenceLines?: { value: number; color: string }[];
  /** Decorations attached to this plot's pane and value scale. */
  overlay?: IndicatorPlotOverlay;
}

export type IndicatorFill = {
  color: string;
  gradient?: {
    top: number;
    bottom: number;
    topColor: string;
    bottomColor: string;
  };
} & (
  | { kind: 'band'; top: number; bottom: number }
  | { kind: 'area'; data: { index: number; upper?: number; lower?: number }[] }
);

export interface IndicatorPlotOverlay {
  drawings: IndicatorDrawing[];
  fills: IndicatorFill[];
  valueRange?: { min: number; max: number };
}

/** Series-pane drawings; coordinates are indices in the loaded bar window. */
export interface IndicatorDrawing {
  id: string;
  kind: 'line' | 'box' | 'label';
  from: number;
  to: number;
  top: number;
  bottom: number;
  color: string;
  style?: string;
  lineWidth?: number;
  border?: boolean;
  extendRight?: boolean;
  text?: string;
  /** Optional filled background for compact event badges. */
  labelBackground?: string;
  labelIndex?: number;
  /** Keep live strategy labels inside the price pane. */
  clampLabel?: boolean;
  labelPrice?: number;
  align?: 'above' | 'below' | 'left';
  size?: string;
}

export interface IndicatorOverlay {
  drawings: IndicatorDrawing[];
  candleColors?: (string | undefined)[];
  warnings?: string[];
}

export interface IndicatorDefinition {
  id: string;
  type: IndicatorType;
  name: string;
  description: string;
  source?: { name: string; url?: string };
  parameters: readonly IndicatorParameter[];
  defaultVisible: boolean;
  requiresCandles?: boolean;
  priceFormat?: 'price' | 'volume' | 'oscillator';
  precision?: number;
  paneWeight?: number;
  validate?: (parameters: IndicatorParameters) => string | undefined;
  render: (
    bars: readonly Bar[],
    parameters: IndicatorParameters,
  ) => IndicatorPlot[];
  renderOverlay?: (
    bars: readonly Bar[],
    parameters: IndicatorParameters,
    duration: number,
    context?: IndicatorContext,
  ) => IndicatorOverlay;
}

export interface IndicatorPreference {
  visible: boolean;
  parameters: IndicatorParameters;
}

export type IndicatorPreferences = Record<string, IndicatorPreference>;
