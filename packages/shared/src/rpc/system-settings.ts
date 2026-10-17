import { z } from 'zod';
import { procedure } from './base.js';
import { desktopContract } from './e2b-desktop.js';
import {
  systemSettingsSchema,
  systemSettingsUpdateSchema,
} from '../system-settings.js';

const path = '/admin/settings';

export const systemSettingsContract = {
  desktop: desktopContract,
  get: procedure
    .route({ method: 'GET', path, inputStructure: 'detailed' })
    .output(systemSettingsSchema),
  update: procedure
    .route({ method: 'PATCH', path, inputStructure: 'detailed' })
    .input(z.object({ body: systemSettingsUpdateSchema }))
    .output(systemSettingsSchema),
};
