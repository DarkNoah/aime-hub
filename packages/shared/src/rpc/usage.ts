import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  usageQuerySchema,
  usageRecordsQuerySchema,
  type UsageSummary,
  type UsageRecordPage,
} from '../usage.js';

export const usageContract = {
  summary: procedure
    .route({ method: 'GET', path: '/admin/usage', inputStructure: 'detailed' })
    .input(z.object({ query: usageQuerySchema }))
    .output(type<UsageSummary>()),
  records: procedure
    .route({
      method: 'GET',
      path: '/admin/usage/records',
      inputStructure: 'detailed',
    })
    .input(z.object({ query: usageRecordsQuerySchema }))
    .output(type<UsageRecordPage>()),
};
