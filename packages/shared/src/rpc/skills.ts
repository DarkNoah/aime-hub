import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  scanSkillsSchema,
  installSkillsSchema,
  removeSkillSchema,
  removeSkillGroupSchema,
  type InstalledSkills,
  type InstalledSkill,
  type SkillScan,
} from '../skills.js';

export const skillsContract = {
  list: procedure
    .route({ method: 'GET', path: '/admin/skills', inputStructure: 'detailed' })
    .output(type<InstalledSkills>()),
  scan: procedure
    .route({
      method: 'POST',
      path: '/admin/skills/scans',
      inputStructure: 'detailed',
    })
    .input(z.object({ body: scanSkillsSchema }))
    .output(type<SkillScan>()),
  discard: procedure
    .route({
      method: 'DELETE',
      path: '/admin/skills/scans/{id}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ id: z.string().uuid() }) }))
    .output(type<void>()),
  install: procedure
    .route({
      method: 'POST',
      path: '/admin/skills/install',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ body: installSkillsSchema }))
    .output(type<InstalledSkill[]>()),
  remove: procedure
    .route({
      method: 'DELETE',
      path: '/admin/skills',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ body: removeSkillSchema }))
    .output(type<void>()),
  removeGroup: procedure
    .route({
      method: 'DELETE',
      path: '/admin/skills/groups',
      inputStructure: 'detailed',
    })
    .input(z.object({ body: removeSkillGroupSchema }))
    .output(type<string[]>()),
};
