import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  pushEndpointSchema,
  pushSubscriptionSchema,
} from '../notifications.js';

export const notificationsContract = {
  config: procedure.output(type<{ publicKey: string | null }>()),
  subscribe: procedure.input(pushSubscriptionSchema).output(type<void>()),
  unsubscribe: procedure
    .input(z.object({ endpoint: pushEndpointSchema }))
    .output(type<void>()),
};
