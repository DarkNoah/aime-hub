import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  MCP_AUTHORIZATION_TOOL,
  mcpAuthorizationSchema,
} from '@aime/shared/mcp';
import { BuiltinTool, type ToolSettings } from '../../modules/tools/base.js';
import type { ToolDependencies } from '../../modules/tools/types.js';

export function createAuthorizationTool(
  mcp?: ToolDependencies['mcpAuthorization'],
) {
  return createTool({
    id: MCP_AUTHORIZATION_TOOL,
    description:
      'Request browser login for an MCP server on behalf of the current user. Use this when an MCP is unauthorized or its tools are absent from ALL_TOOLS. Pass mcpId when known; omit it to show available MCP services requiring authorization. Renders a login card directly in the conversation, outside collapsed tool details. The user clicks to authorize in their own browser; credentials remain private to that user. Call this tool directly, never inside exec. After authorization, discover the MCP tools again and continue the task. Never ask the user to paste passwords, authorization codes or tokens into chat.',
    inputSchema: z.object({
      mcpId: z
        .string()
        .optional()
        .describe(
          'MCP server ID. Omit to choose from published OAuth MCP services.',
        ),
      reason: z
        .string()
        .optional()
        .describe('Briefly explain why access is needed.'),
    }),
    resumeSchema: z.object({
      mcpId: z.string().optional(),
      cancelled: z.boolean().optional(),
    }),
    suspendSchema: z.object({
      services: z.array(mcpAuthorizationSchema),
      reason: z.string().optional(),
      userId: z.string(),
    }),
    execute: async (input, context) => {
      const signal = context?.abortSignal;
      if (signal?.aborted) return '用户中止了操作';
      const userId = context?.requestContext?.get('userId');
      if (typeof userId !== 'string' || !userId || !mcp)
        return { error: '当前会话无法发起 MCP 登录授权。' };
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<string>((resolve) => {
        onAbort = () => resolve('用户中止了操作');
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([
          aborted,
          (async () => {
            const resume = context?.agent?.resumeData as
              { mcpId?: string; cancelled?: boolean } | undefined;
            if (resume?.cancelled) return { cancelled: true };
            if (resume && input.mcpId && resume.mcpId !== input.mcpId)
              return { error: '授权的 MCP 与请求不匹配。' };
            const id = resume?.mcpId ?? input.mcpId;
            const services = await mcp.authorizations(userId, id);
            if (signal?.aborted) return '用户中止了操作';
            if (resume) {
              const service = services.find((item) => item.id === id);
              // Never trust the browser's claim that authorization succeeded.
              if (!service || service.authStatus !== 'authorized')
                return {
                  error: '当前用户尚未完成此 MCP 的授权，请重新发起登录。',
                };
              return { authorized: true, services: [service] };
            }
            if (!services.length)
              return {
                error:
                  '没有可用的 OAuth MCP 服务，请联系管理员配置并发布 MCP。',
              };
            if (
              services.every((service) => service.authStatus === 'authorized')
            )
              return { authorized: true, services };
            if (!context?.agent?.suspend)
              return {
                error: '请在交互式聊天中直接调用 request_authorization。',
              };
            return context.agent.suspend({
              services: id
                ? services
                : services.filter(
                    (service) => service.authStatus === 'required',
                  ),
              reason: input.reason,
              userId,
            });
          })(),
        ]);
      } catch {
        return signal?.aborted
          ? '用户中止了操作'
          : { error: '无法读取 MCP 授权状态，请检查 MCP 是否仍已发布。' };
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      }
    },
  });
}

export class AuthorizationTool extends BuiltinTool {
  constructor() {
    super(createAuthorizationTool());
  }
  protected override create(
    _config: ToolSettings<'builtin'>,
    dependencies: ToolDependencies,
  ) {
    return createAuthorizationTool(dependencies.mcpAuthorization);
  }
}
