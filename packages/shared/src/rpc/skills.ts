import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  fileSaveSchema,
  type FileListing,
  type FilePreview,
} from '../files.js';
import {
  scanSkillsSchema,
  installSkillsSchema,
  removeSkillSchema,
  readSkillSchema,
  removeSkillGroupSchema,
  updateSkillGroupSchema,
  type SkillContent,
  type InstalledSkills,
  type InstalledSkill,
  type SkillScan,
} from '../skills.js';

function createSkillsContract(basePath: '/admin/skills' | '/skills') {
  return {
    files: {
      list: procedure
        .route({
          method: 'GET',
          path: `${basePath}/files`,
          inputStructure: 'detailed',
        })
        .input(
          z.object({
            query: z.object({ skill: z.string(), path: z.string() }),
          }),
        )
        .output(type<FileListing>()),
      preview: procedure
        .route({
          method: 'GET',
          path: `${basePath}/files/preview`,
          inputStructure: 'detailed',
        })
        .input(
          z.object({
            query: z.object({ skill: z.string(), path: z.string() }),
          }),
        )
        .output(type<FilePreview>()),
      save: procedure
        .route({
          method: 'PUT',
          path: `${basePath}/files/content`,
          inputStructure: 'detailed',
        })
        .input(
          z.object({
            query: z.object({ skill: z.string() }),
            body: fileSaveSchema,
          }),
        )
        .output(type<{ file: FilePreview; skill: InstalledSkill }>()),
    },
    list: procedure
      .route({ method: 'GET', path: basePath, inputStructure: 'detailed' })
      .output(type<InstalledSkills>()),
    read: procedure
      .route({
        method: 'GET',
        path: `${basePath}/content`,
        inputStructure: 'detailed',
      })
      .input(z.object({ query: readSkillSchema }))
      .output(type<SkillContent>()),
    updateGroup: procedure
      .route({
        method: 'POST',
        path: `${basePath}/groups/update`,
        inputStructure: 'detailed',
      })
      .input(z.object({ body: updateSkillGroupSchema }))
      .output(type<InstalledSkill[]>()),
    scan: procedure
      .route({
        method: 'POST',
        path: `${basePath}/scans`,
        inputStructure: 'detailed',
      })
      .input(z.object({ body: scanSkillsSchema }))
      .output(type<SkillScan>()),
    discard: procedure
      .route({
        method: 'DELETE',
        path: `${basePath}/scans/{id}`,
        inputStructure: 'detailed',
        successStatus: 204,
      })
      .input(z.object({ params: z.object({ id: z.string().uuid() }) }))
      .output(type<void>()),
    install: procedure
      .route({
        method: 'POST',
        path: `${basePath}/install`,
        inputStructure: 'detailed',
        successStatus: 201,
      })
      .input(z.object({ body: installSkillsSchema }))
      .output(type<InstalledSkill[]>()),
    remove: procedure
      .route({
        method: 'DELETE',
        path: basePath,
        inputStructure: 'detailed',
        successStatus: 204,
      })
      .input(z.object({ body: removeSkillSchema }))
      .output(type<void>()),
    removeGroup: procedure
      .route({
        method: 'DELETE',
        path: `${basePath}/groups`,
        inputStructure: 'detailed',
      })
      .input(z.object({ body: removeSkillGroupSchema }))
      .output(type<string[]>()),
  };
}

export const skillsContract = createSkillsContract('/admin/skills');
export const personalSkillsContract = createSkillsContract('/skills');
