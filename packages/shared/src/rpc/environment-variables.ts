import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  environmentVariableInputSchema,
  environmentVariableUpdateSchema,
  type EnvironmentVariable,
} from '../environment-variables.js';

const params = z.object({ id: z.string().uuid() });
const path = '/admin/environment-variables';

export const environmentVariablesContract = {
  list: procedure
    .route({ method: 'GET', path, inputStructure: 'detailed' })
    .output(type<EnvironmentVariable[]>()),
  get: procedure
    .route({ method: 'GET', path: `${path}/{id}`, inputStructure: 'detailed' })
    .input(z.object({ params }))
    .output(type<EnvironmentVariable>()),
  create: procedure
    .route({
      method: 'POST',
      path,
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ body: environmentVariableInputSchema }))
    .output(type<EnvironmentVariable>()),
  update: procedure
    .route({
      method: 'PATCH',
      path: `${path}/{id}`,
      inputStructure: 'detailed',
    })
    .input(z.object({ params, body: environmentVariableUpdateSchema }))
    .output(type<EnvironmentVariable>()),
  remove: procedure
    .route({
      method: 'DELETE',
      path: `${path}/{id}`,
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params }))
    .output(type<void>()),
};
