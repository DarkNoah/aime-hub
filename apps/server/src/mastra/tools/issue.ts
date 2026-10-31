import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ORPCError } from '@orpc/server';
import { chatSettingsSchema } from '@aime/shared/threads';
import {
  issueCreateSchema,
  issuePatchSchema,
  issueListSchema,
  issueMessageSchema,
} from '@aime/shared/issues';
import { BuiltinTool, type ToolSettings } from '../../modules/tools/base.js';
import type { ToolDependencies } from '../../modules/tools/types.js';
import type { IssueService } from '../../modules/issues/service.js';
import { issueHelp, parseIssueCommand } from '../../modules/issues/command.js';
import { ThreadError } from '../../modules/threads/errors.js';
import { AgentError } from '../../modules/agents/errors.js';
import { getCodeAgent } from '../agents/index.js';

export type ResolveIssues = () => Pick<
  IssueService,
  'list' | 'view' | 'create' | 'edit' | 'stop' | 'message' | 'comment'
>;

export function createIssueTool(resolve?: ResolveIssues) {
  return createTool({
    id: 'issue',
    description: `Manage persistent tasks with GitHub-style issue commands in the current personal/project scope. Create an issue only for substantial, long-running tasks or work strongly related to an existing task. Reuse related issues. Simple exploration, research, search and direct answers do not need issues. Creation binds a new chat thread; list/view first to avoid duplicates. Do not create a replacement issue from inside its own task thread. Completion must be verified before close.\n${issueHelp}`,
    inputSchema: z.object({
      command: z
        .string()
        .describe(
          'One issue command, e.g. create --title "修复登录" --body "任务和验收标准", list --state open, view 123, edit 123 --message "继续" --delivery wait, close 123. Quote values containing spaces or flags.',
        ),
    }),
    execute: async ({ command }, context) => {
      const signal = context?.abortSignal;
      if (signal?.aborted) return '用户中止了操作';
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<string>((resolveAbort) => {
        onAbort = () => resolveAbort('用户中止了操作');
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      const operation = async () => {
        const { action, id, values } = parseIssueCommand(command);
        const userId = context?.requestContext?.get('userId');
        const projectId = context?.requestContext?.get('projectId');
        if (typeof userId !== 'string' || !userId)
          throw new Error('Issue 工具需要已认证用户');
        if (action === 'help') return { help: issueHelp };
        if (!resolve) throw new Error('Issue 服务不可用');
        const service = resolve();
        const scope =
          typeof projectId === 'string' && projectId ? { projectId } : {};
        signal?.throwIfAborted();
        if (action === 'list')
          return service.list(
            userId,
            issueListSchema.parse({
              ...scope,
              state: values.state,
              cursor: values.cursor ? Number(values.cursor) : undefined,
              limit: values.limit ? Number(values.limit) : undefined,
            }),
          );
        if (action === 'view')
          return service.view(userId, id!, scope, values.cursor);
        if (action === 'create') {
          const sourceThreadId = context?.requestContext?.get(
            'issueSourceThreadId',
          );
          const settings = chatSettingsSchema.parse(
            context?.requestContext?.get('chatSettings') ?? {},
          );
          // The room leader is valid only with a trusted room binding. An issue
          // gets an ordinary chat, so resolve its default Agent while retaining
          // the current model and reasoning settings. Normal worker Agents stay.
          if (settings.agentId && getCodeAgent(settings.agentId)?.hidden)
            settings.agentId = null;
          const issue = await service.create(
            userId,
            scope,
            issueCreateSchema.parse({
              title: values.title,
              body: values.body,
              state: values.state,
              settings,
            }),
            signal,
            typeof sourceThreadId === 'string' ? sourceThreadId : undefined,
          );
          if (values.start) {
            signal?.throwIfAborted();
            try {
              return {
                issue: await service.message(
                  userId,
                  issue.id,
                  scope,
                  `${issue.title}\n\n${issue.body || '请完成此任务，并验证结果。'}`,
                  'wait',
                  signal,
                ),
              };
            } catch (error) {
              if (signal?.aborted) throw error;
              return {
                issue,
                error:
                  'Issue 已创建，但任务未成功提交。请打开线程检查模型配置或待处理交互后重试。',
              };
            }
          }
          return { issue };
        }
        if (action === 'close' || action === 'reopen')
          return {
            issue: await service.edit(userId, id!, scope, {
              state: action === 'close' ? 'done' : 'todo',
            }),
          };
        if (action === 'comment')
          return {
            comment: await service.comment(userId, id!, scope, values.body!),
          };
        const patch = issuePatchSchema.parse({
          title: values.title,
          body: values.body,
          state: values.state,
        });
        if (values.message !== undefined)
          issueMessageSchema.parse({
            body: values.message,
            delivery: values.delivery,
          });
        // Validate the entire command before making any changes.
        let issue;
        if (Object.values(patch).some((value) => value !== undefined))
          issue = await service.edit(userId, id!, scope, patch);
        signal?.throwIfAborted();
        if (values.stop) issue = await service.stop(userId, id!, scope);
        if (values.message)
          issue = await service.message(
            userId,
            id!,
            scope,
            values.message,
            values.delivery === 'immediate' ? 'immediate' : 'wait',
            signal,
          );
        return { issue };
      };
      try {
        return await Promise.race([
          operation().catch((error: unknown) => {
            if (signal?.aborted) return '用户中止了操作';
            if (
              error instanceof ORPCError ||
              error instanceof ThreadError ||
              error instanceof AgentError
            )
              return { error: error.code };
            if (error instanceof z.ZodError)
              return {
                error: error.issues.map((item) => item.message).join('; '),
              };
            // Command errors are safe text; database errors must never expose SQL or credentials.
            if (error instanceof Error && error.constructor === Error)
              return { error: error.message };
            return { error: 'Issue 操作失败，请稍后重试' };
          }),
          aborted,
        ]);
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      }
    },
  });
}

export class IssueTool extends BuiltinTool {
  constructor() {
    super(createIssueTool());
  }
  protected override create(
    _config: ToolSettings<'builtin'>,
    dependencies: ToolDependencies,
  ) {
    return createIssueTool(dependencies.issues);
  }
}
