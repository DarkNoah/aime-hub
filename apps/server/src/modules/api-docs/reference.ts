import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import type { RpcContext } from '../../rpc/context.js';

export function createApiReferencePlugin() {
  return new OpenAPIReferencePlugin<RpcContext>({
    docsPath: '/docs',
    specPath: '/openapi.json',
    docsProvider: 'scalar',
    docsTitle: 'API Reference',
    schemaConverters: [new ZodToJsonSchemaConverter()],
    specGenerateOptions: {
      info: { title: 'API Reference', version: 'development' },
      servers: [{ url: '/api' }],
    },
  });
}
