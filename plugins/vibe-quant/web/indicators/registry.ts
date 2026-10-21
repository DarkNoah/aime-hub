import { maIndicator } from './main/ma';
import { smcIndicator } from './main/smc';
import { macdIndicator } from './sub/macd';
import { volumeIndicator } from './sub/volume';
import type { IndicatorDefinition } from './types';

/** Register each independent script here; menus and settings follow automatically. */
export const INDICATORS: readonly IndicatorDefinition[] = [
  maIndicator,
  smcIndicator,
  volumeIndicator,
  macdIndicator,
];
