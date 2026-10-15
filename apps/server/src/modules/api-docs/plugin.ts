import type { OpenAPIReferencePlugin } from '@orpc/openapi/plugins';
import type { RpcContext } from '../../rpc/context.js';

// tsup replaces this with false, removing the documentation imports from releases.
declare const __API_DOCS_ENABLED__: boolean;

export async function createApiDocsPlugin(
  environment: string | undefined,
): Promise<OpenAPIReferencePlugin<RpcContext> | undefined> {
  if (
    (typeof __API_DOCS_ENABLED__ === 'undefined' || __API_DOCS_ENABLED__) &&
    environment === 'development'
  ) {
    const { createApiReferencePlugin } = await import('./reference.js');
    return createApiReferencePlugin();
  }

  return undefined;
}
