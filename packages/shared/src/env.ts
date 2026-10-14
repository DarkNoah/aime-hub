import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { webOriginsEnvSchema } from './web-origins.js';

config({
  path: resolve(process.env.INIT_CWD ?? process.cwd(), '.env'),
  quiet: true,
});

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  ALLOW_INSECURE_HTTP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ALLOW_ALL_NETWORKS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:/.test(value)),
  BETTER_AUTH_SECRET: z.string().min(32),
  WEB_ORIGINS: webOriginsEnvSchema,
  SERVER_HOST: z.string().min(1).default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  ADMINS: z.string().default('admin'),
  WORKSPACE_ROOT: z.string().min(1).default('workspaces'),
  WEB_PUSH_PUBLIC_KEY: z.string().default(''),
  WEB_PUSH_PRIVATE_KEY: z.string().default(''),
  WEB_PUSH_SUBJECT: z
    .string()
    .refine((value) => !value || /^(mailto:|https:\/\/)/.test(value))
    .default(''),
});

export function loadEnv() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Do not include field values: they can contain credentials.
    throw new Error(
      `环境配置无效，请检查 .env: ${[...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ')}`,
    );
  }
  if (
    result.data.NODE_ENV === 'production' &&
    !result.data.ALLOW_INSECURE_HTTP &&
    result.data.WEB_ORIGINS.some((url) => !url.startsWith('https://'))
  ) {
    throw new Error('生产环境 WEB_ORIGINS 必须使用 HTTPS');
  }
  return result.data;
}
