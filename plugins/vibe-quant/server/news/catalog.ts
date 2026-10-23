import { createHash } from 'node:crypto';
import catalog from './sources.json' with { type: 'json' };
import type { NewsSource } from '../../news-types.js';

export const newsIndustries = catalog.industries;
export const newsSources: NewsSource[] = catalog.sources.map((source) => ({
  id: createHash('sha256').update(source.url).digest('hex').slice(0, 24),
  name: source.name,
  industry: source.hint,
  url: source.url,
  enabled: true,
  contentMode: 'page',
  failureCount: 0,
  lastError: '',
  autoDisabled: false,
}));
