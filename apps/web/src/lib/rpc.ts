import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { apiContract } from '@aime/shared/rpc';

export type ApiClient = ContractRouterClient<typeof apiContract>;

export function createApiClient(
  baseURL: () => string = () =>
    new URL('/api/rpc', window.location.origin).href,
): ApiClient {
  return createORPCClient(
    new RPCLink({
      url: baseURL,
      // Resolve fetch at call time for tests, and always use the session cookie.
      fetch: (request, init) =>
        globalThis.fetch(request, { ...init, credentials: 'same-origin' }),
    }),
  );
}

export const api = createApiClient();
export function apiErrorCode(error: unknown): string | undefined {
  if (error instanceof ORPCError) return error.code;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  )
    return error.code;
}
