import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  requestLogQuerySchema,
  type RequestLogDetail,
  type RequestLogPage,
} from '../request-logs.js';

export const requestLogsContract = {
  list: procedure
    .route({
      method: 'GET',
      path: '/admin/request-logs',
      inputStructure: 'detailed',
    })
    .input(z.object({ query: requestLogQuerySchema }))
    .output(type<RequestLogPage>()),
  get: procedure
    .route({
      method: 'GET',
      path: '/admin/request-logs/{id}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ id: z.string().uuid() }) }))
    .output(type<RequestLogDetail>()),
};
