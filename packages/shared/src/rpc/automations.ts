import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, id } from './base.js';
import {
  automationInputSchema,
  automationScopeSchema,
  type Automation,
  type AutomationList,
  type AutomationRun,
} from '../automations.js';

const target = z.object({ id });
export const automationsContract = {
  list: procedure.input(automationScopeSchema).output(type<AutomationList>()),
  create: procedure
    .input(
      z.object({ scope: automationScopeSchema, data: automationInputSchema }),
    )
    .output(type<Automation>()),
  update: procedure
    .input(target.extend({ data: automationInputSchema }))
    .output(type<Automation>()),
  setEnabled: procedure
    .input(target.extend({ enabled: z.boolean() }))
    .output(type<Automation>()),
  remove: procedure.input(target).output(type<void>()),
  run: procedure.input(target).output(type<Automation>()),
  history: procedure.input(target).output(type<AutomationRun[]>()),
};
