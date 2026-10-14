import { z } from 'zod';
import { procedure } from './base.js';
import {
  systemSettingsSchema,
  systemSettingsUpdateSchema,
} from '../system-settings.js';

const path = '/admin/settings';

export const systemSettingsContract = {
  get: procedure
    .route({ method: 'GET', path, inputStructure: 'detailed' })
    .output(systemSettingsSchema),
  update: procedure
    .route({ method: 'PATCH', path, inputStructure: 'detailed' })
    .input(z.object({ body: systemSettingsUpdateSchema }))
    .output(systemSettingsSchema),
};
