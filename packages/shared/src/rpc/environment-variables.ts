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

const personal = procedure.meta({ localApi: true });
const personalPath = '/personal/environment-variables';

export const personalEnvironmentVariablesContract = {
  list: personal
    .route({
      method: 'GET',
      path: personalPath,
      inputStructure: 'detailed',
      summary: '列出当前用户的环境变量',
    })
    .output(type<EnvironmentVariable[]>()),
  get: personal
    .route({
      method: 'GET',
      path: `${personalPath}/{id}`,
      inputStructure: 'detailed',
      summary: '读取当前用户的环境变量',
    })
    .input(z.object({ params }))
    .output(type<EnvironmentVariable>()),
  create: personal
    .route({
      method: 'POST',
      path: personalPath,
      inputStructure: 'detailed',
      successStatus: 201,
      summary: '创建当前用户的环境变量',
    })
    .input(z.object({ body: environmentVariableInputSchema }))
    .output(type<EnvironmentVariable>()),
  update: personal
    .route({
      method: 'PATCH',
      path: `${personalPath}/{id}`,
      inputStructure: 'detailed',
      summary: '修改当前用户的环境变量',
    })
    .input(z.object({ params, body: environmentVariableUpdateSchema }))
    .output(type<EnvironmentVariable>()),
  remove: personal
    .route({
      method: 'DELETE',
      path: `${personalPath}/{id}`,
      inputStructure: 'detailed',
      successStatus: 204,
      summary: '删除当前用户的环境变量',
    })
    .input(z.object({ params }))
    .output(type<void>()),
};

const project = procedure.meta({ localApi: true });
const projectParams = z.object({ projectId: z.string().min(1) });
const projectItemParams = projectParams.extend(params.shape);
const projectPath = '/projects/{projectId}/environment-variables';

export const projectEnvironmentVariablesContract = {
  list: project
    .route({
      method: 'GET',
      path: projectPath,
      inputStructure: 'detailed',
      summary: '列出项目环境变量（项目管理员）',
    })
    .input(z.object({ params: projectParams }))
    .output(type<EnvironmentVariable[]>()),
  get: project
    .route({
      method: 'GET',
      path: `${projectPath}/{id}`,
      inputStructure: 'detailed',
      summary: '读取项目环境变量（项目管理员）',
    })
    .input(z.object({ params: projectItemParams }))
    .output(type<EnvironmentVariable>()),
  create: project
    .route({
      method: 'POST',
      path: projectPath,
      inputStructure: 'detailed',
      successStatus: 201,
      summary: '创建项目环境变量（项目管理员）',
    })
    .input(
      z.object({ params: projectParams, body: environmentVariableInputSchema }),
    )
    .output(type<EnvironmentVariable>()),
  update: project
    .route({
      method: 'PATCH',
      path: `${projectPath}/{id}`,
      inputStructure: 'detailed',
      summary: '修改项目环境变量（项目管理员）',
    })
    .input(
      z.object({
        params: projectItemParams,
        body: environmentVariableUpdateSchema,
      }),
    )
    .output(type<EnvironmentVariable>()),
  remove: project
    .route({
      method: 'DELETE',
      path: `${projectPath}/{id}`,
      inputStructure: 'detailed',
      successStatus: 204,
      summary: '删除项目环境变量（项目管理员）',
    })
    .input(z.object({ params: projectItemParams }))
    .output(type<void>()),
};
