import { apiContract } from '@aime/shared/rpc';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

/** Generate from the same contracts and opt-in metadata used by the API middleware. */
export function generateLocalApiSpec(
  router: Parameters<OpenAPIGenerator['generate']>[0] = apiContract,
) {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  return generator.generate(router, {
    info: { title: 'Local Skill API', version: '1' },
    servers: [{ url: '/api' }],
    filter: ({ contract }) => contract['~orpc'].meta.localApi === true,
    security: [{ localBearer: [] }],
    components: {
      securitySchemes: {
        localBearer: { type: 'http', scheme: 'bearer' },
      },
    },
  });
}
