import { z } from 'zod';

const singleLine = z
  .string()
  .max(16384)
  .regex(/^[^\r\n\0]*$/);
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const mcpNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name));

export const mcpConfigSchema = z
  .strictObject({
    command: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .regex(/^[^\r\n\0]+$/)
      .optional(),
    args: z
      .array(singleLine)
      .max(256)
      .transform((args) => args.filter((arg) => arg.trim().length > 0))
      .optional(),
    url: z
      .string()
      .trim()
      .max(8192)
      .url()
      .refine((value) => {
        try {
          return ['http:', 'https:'].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      })
      .optional(),
    headers: z.record(headerName, singleLine).optional(),
    env: z.record(envName, singleLine).optional(),
  })
  .superRefine((config, ctx) => {
    if (Boolean(config.command) === Boolean(config.url)) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'mcp.transportInvalid',
      });
    }
    if (config.url && config.args !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['args'],
        message: 'mcp.argsHttpInvalid',
      });
    }
    if (config.url && config.env !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['env'],
        message: 'mcp.envHttpInvalid',
      });
    if (config.command && config.headers !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: 'mcp.headersStdioInvalid',
      });
    const headerNames = Object.keys(config.headers ?? {}).map((key) =>
      key.toLowerCase(),
    );
    if (new Set(headerNames).size !== headerNames.length)
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: 'mcp.duplicateKey',
      });
    for (const field of ['headers', 'env'] as const) {
      if (Object.keys(config[field] ?? {}).length > 100)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'mcp.configInvalid',
        });
    }
  });

export const mcpInputSchema = z.strictObject({
  name: mcpNameSchema,
  config: mcpConfigSchema,
});
export const mcpCreateSchema = z
  .strictObject({
    servers: z.array(mcpInputSchema).min(1).max(50),
  })
  .superRefine(({ servers }, ctx) => {
    const names = new Set<string>();
    servers.forEach(({ name }, index) => {
      if (names.has(name))
        ctx.addIssue({
          code: 'custom',
          path: ['servers', index, 'name'],
          message: 'mcp.duplicateName',
        });
      names.add(name);
    });
  });
export const mcpUpdateSchema = mcpInputSchema.extend({
  revision: z.string().uuid(),
});
export const mcpStatusSchema = z.strictObject({
  status: z.enum(['draft', 'published']),
  revision: z.string().uuid(),
});
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpInput = z.infer<typeof mcpInputSchema>;
export type McpCreate = z.infer<typeof mcpCreateSchema>;
export type McpUpdate = z.infer<typeof mcpUpdateSchema>;
export type McpStatus = z.infer<typeof mcpStatusSchema>;
export type McpServer = McpInput & {
  id: string;
  status: 'draft' | 'published' | 'archived';
  revision: string;
  createdAt: string;
  updatedAt: string;
};

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
};
