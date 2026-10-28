import type { ToolExecutionContext } from '@mastra/core/tools';
import type { PluginContext } from '@app/plugin-sdk/server';
import { hasAdminRole } from '@aime/shared';
import { ZodError } from 'zod';
import type { QuantConfig } from '../../server/config.js';
import type { StateStore } from '../../server/state-store.js';
import type { StrategyStore } from '../../server/strategies/store.js';
import type { NewsStore } from '../../server/news/store.js';
import { StrategyError } from '../../server/strategies/schema.js';
import { FactorError } from '../../server/factors/schema.js';
import type { FactorStore } from '../../server/factors/store.js';
import type { FactorService } from '../../server/factors/service.js';

export interface QuantDependencies {
  factors?: FactorStore;
  factorService?: FactorService;
  records: Pick<
    StrategyStore,
    | 'list'
    | 'detail'
    | 'save'
    | 'versions'
    | 'version'
    | 'publish'
    | 'enqueue'
    | 'runs'
    | 'run'
    | 'cancel'
    | 'artifact'
  >;
  state: Pick<StateStore, 'search' | 'instrument'>;
  news: Pick<NewsStore, 'list' | 'article'>;
  config: QuantConfig;
  wake: () => void;
}

export function quantToolContext(
  context: PluginContext,
  get: () => QuantDependencies,
) {
  return async function execute<T>(
    execution:
      Pick<ToolExecutionContext, 'abortSignal' | 'requestContext'> | undefined,
    run: (
      deps: QuantDependencies,
      actor: { userId: string; isAdmin: boolean },
      signal?: AbortSignal,
    ) => Promise<T>,
  ) {
    const signal = execution?.abortSignal;
    let onAbort: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      const task = async () => {
        const userId = execution?.requestContext?.get('userId');
        if (typeof userId !== 'string' || !userId)
          throw new StrategyError('UNAUTHORIZED', 403);
        await context.assertEnabled();
        signal?.throwIfAborted();
        // Resolve the current message author from trusted context, never model-supplied roles.
        const [user] = await context.database.query<
          { role: string | null; banned: boolean | null }[]
        >('SELECT role, banned FROM users WHERE id = $1', [userId]);
        signal?.throwIfAborted();
        if (!user || user.banned) throw new StrategyError('UNAUTHORIZED', 403);
        return run(get(), { userId, isAdmin: hasAdminRole(user.role) }, signal);
      };
      return await (signal
        ? Promise.race([
            new Promise<never>((_, reject) => {
              onAbort = () => reject(signal.reason);
              signal.addEventListener('abort', onAbort, { once: true });
            }),
            task(),
          ])
        : task());
    } catch (error) {
      if (signal?.aborted)
        return { cancelled: true as const, message: '用户中止了操作' };
      if (error instanceof StrategyError) return { error: error.code };
      if (error instanceof FactorError)
        return { error: 'FACTOR_ERROR', message: error.message };
      if (error instanceof ZodError)
        return {
          error: 'INVALID_ARGUMENTS',
          issues: error.issues.map(({ path, message }) => ({
            field: path.join('.'),
            message,
          })),
        };
      // Infrastructure errors may include connection details. Keep them out of the transcript.
      return {
        error: 'QUANT_SERVICE_UNAVAILABLE',
        message: '量化服务暂不可用，请检查插件状态后重试。',
      };
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };
}
