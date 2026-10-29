import { maIndicator } from './main/ma';
import { orbIndicator } from './main/orb';
import { logisticSrIndicator } from './main/logistic-sr';
import { smcIndicator } from './main/smc';
import { volumeProfileIndicator } from './main/volume-profile';
import { macdIndicator } from './sub/macd';
import { rsiIndicator } from './sub/rsi';
import { volumeIndicator } from './sub/volume';
import type { IndicatorDefinition } from './types';

/** Register each independent script here; menus and settings follow automatically. */
export const INDICATORS: readonly IndicatorDefinition[] = [
  maIndicator,
  orbIndicator,
  smcIndicator,
  logisticSrIndicator,
  volumeProfileIndicator,
  volumeIndicator,
  macdIndicator,
  rsiIndicator,
];
