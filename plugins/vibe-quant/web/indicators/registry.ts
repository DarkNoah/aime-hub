import { maIndicator } from './main/ma';
import { macdIndicator } from './sub/macd';
import { volumeIndicator } from './sub/volume';
import type { IndicatorDefinition } from './types';

/** Register each independent script here; menus and settings follow automatically. */
export const INDICATORS: readonly IndicatorDefinition[] = [
  maIndicator,
  volumeIndicator,
  macdIndicator,
];
