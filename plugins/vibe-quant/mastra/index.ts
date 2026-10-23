import type { PluginContext } from '@app/plugin-sdk/server';
import { quantAgent } from './agents/quant-agent.js';
import { createStrategyTools } from './tools/strategies.js';
import { createBacktestTools } from './tools/backtests.js';
import { createNewsTools } from './tools/news.js';
import type { QuantDependencies } from './tools/context.js';

export function createQuantMastra(
  context: PluginContext,
  get: () => QuantDependencies,
) {
  return {
    agents: [quantAgent],
    tools: [
      ...createStrategyTools(context, get),
      ...createBacktestTools(context, get),
      ...createNewsTools(context, get),
    ],
  };
}
