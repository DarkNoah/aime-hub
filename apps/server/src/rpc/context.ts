import { implement, ORPCError, ValidationError } from '@orpc/server';
import { apiContract } from '@aime/shared/rpc';
import { hasAdminRole } from '@aime/shared';
import type { Auth } from '@aime/auth';
import { ThreadError } from '../modules/threads/errors.js';
import { ProviderError } from '../modules/providers/network.js';
import { SkillError } from '../modules/skills/errors.js';
import { EnvironmentVariableError } from '../modules/environment-variables/errors.js';
import { AgentError } from '../modules/agents/errors.js';
import { McpError } from '../modules/mcp/errors.js';
import type { LocalApiAccess } from '../modules/auth/local-api.js';

export type RpcContext = {
  auth: Auth;
  headers: Headers;
  webOrigins: readonly string[];
  method: string;
  localApi?: LocalApiAccess;
};

export function mapRpcError(error: unknown): never {
  if (
    error instanceof AgentError ||
    error instanceof McpError ||
    error instanceof ThreadError ||
    error instanceof ProviderError ||
    error instanceof SkillError ||
    error instanceof EnvironmentVariableError
  )
    throw new ORPCError(error.code, {
      status: error.status,
      message: error.code,
    });
  if (error instanceof ORPCError) {
    if (error.code === 'BAD_REQUEST' && error.cause instanceof ValidationError)
      throw new ORPCError('VALIDATION_ERROR', {
        status: 400,
        message: 'VALIDATION_ERROR',
      });
    throw error;
  }
  // Never send provider credentials, database details or local paths to clients.
  console.error(
    '请求处理失败',
    error instanceof Error ? error.name : 'UnknownError',
  );
  throw new ORPCError('INTERNAL_ERROR', {
    status: 500,
    message: '服务暂时不可用，请稍后重试',
  });
}

const implementation = implement(apiContract).$context<RpcContext>();
export const rpc = implementation.use(
  async ({ context, path, procedure, next }) => {
    try {
      const authorization = context.headers.get('authorization');
      const delegatedUser = authorization
        ? await context.localApi?.authenticate(authorization)
        : undefined;
      // An invalid delegated credential must never fall back to a browser cookie.
      if (authorization && !delegatedUser) throw new ORPCError('UNAUTHORIZED');
      if (delegatedUser && procedure['~orpc'].meta.localApi !== true)
        throw new ORPCError('FORBIDDEN');
      const session = delegatedUser
        ? null
        : await context.auth.api.getSession({ headers: context.headers });
      if (!delegatedUser && !session) throw new ORPCError('UNAUTHORIZED');
      const admin =
        (path[0] === 'agents' && path[1] !== 'available') ||
        path[0] === 'skills' ||
        path[0] === 'environmentVariables' ||
        path[0] === 'requestLogs' ||
        path[0] === 'usage' ||
        path[0] === 'tools' ||
        path[0] === 'mcp' ||
        path[0] === 'systemSettings' ||
        (path[0] === 'providers' && path[1] !== 'available');
      if (admin && !hasAdminRole(session?.user.role))
        throw new ORPCError('FORBIDDEN');
      if (
        !delegatedUser &&
        !['GET', 'HEAD', 'OPTIONS'].includes(context.method) &&
        !context.webOrigins.includes(context.headers.get('origin') ?? '')
      )
        throw new ORPCError('FORBIDDEN');
      return await next({
        context: {
          userId: delegatedUser ?? session!.user.id,
          isAdmin: hasAdminRole(session?.user.role),
          session: session?.session,
        },
      });
    } catch (error) {
      mapRpcError(error);
    }
  },
);

export function required<T>(service: T | undefined): T {
  if (!service) throw new ORPCError('NOT_IMPLEMENTED');
  return service;
}
