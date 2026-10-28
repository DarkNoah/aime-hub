import { lazy } from 'react';
import type { PluginPageProps, PluginWeb } from '@app/plugin-sdk/web';

const LazyMarketPage = lazy(() =>
  import('./market-page').then((module) => ({ default: module.MarketPage })),
);

const LazyStrategiesPage = lazy(() => import('./strategies/page'));
const LazyNewsPage = lazy(() => import('./news/page'));
const LazyFactorsPage = lazy(() => import('./factors/page'));

// The host lazily loads page entries, so expose a component rather than another lazy object.
function MarketPage(props: PluginPageProps) {
  return <LazyMarketPage {...props} />;
}
function StrategiesPage(props: PluginPageProps) {
  return <LazyStrategiesPage {...props} />;
}
function NewsPage(props: PluginPageProps) {
  return <LazyNewsPage {...props} />;
}
function FactorsPage(props: PluginPageProps) {
  return <LazyFactorsPage {...props} />;
}

export default {
  pages: {
    '': MarketPage,
    strategies: StrategiesPage,
    factors: FactorsPage,
    news: NewsPage,
  },
} satisfies PluginWeb;
