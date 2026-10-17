import { z } from 'zod';
import { procedure } from './base.js';
import {
  desktopSandboxCreateSchema,
  desktopSandboxIdSchema,
  desktopSandboxListSchema,
  desktopSandboxSchema,
  desktopSandboxUpdateSchema,
} from '../e2b-desktop.js';

const path = '/admin/settings/e2b-desktop';
const params = z.object({ id: desktopSandboxIdSchema });
export const desktopContract = {
  test: procedure
    .route({ method: 'POST', path: `${path}/test`, inputStructure: 'detailed' })
    .output(z.object({ ok: z.literal(true) })),
  list: procedure
    .route({
      method: 'GET',
      path: `${path}/sandboxes`,
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        query: z.object({ nextToken: z.string().optional() }).optional(),
      }),
    )
    .output(desktopSandboxListSchema),
  create: procedure
    .route({
      method: 'POST',
      path: `${path}/sandboxes`,
      inputStructure: 'detailed',
    })
    .input(z.object({ body: desktopSandboxCreateSchema }))
    .output(z.object({ id: desktopSandboxIdSchema })),
  get: procedure
    .route({
      method: 'GET',
      path: `${path}/sandboxes/{id}`,
      inputStructure: 'detailed',
    })
    .input(z.object({ params }))
    .output(desktopSandboxSchema),
  update: procedure
    .route({
      method: 'PATCH',
      path: `${path}/sandboxes/{id}`,
      inputStructure: 'detailed',
    })
    .input(z.object({ params, body: desktopSandboxUpdateSchema }))
    .output(z.object({ ok: z.literal(true) })),
  delete: procedure
    .route({
      method: 'DELETE',
      path: `${path}/sandboxes/{id}`,
      inputStructure: 'detailed',
    })
    .input(z.object({ params }))
    .output(z.object({ ok: z.literal(true) })),
};
