import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

config({
  path: resolve(process.env.INIT_CWD ?? process.cwd(), '.env'),
  quiet: true,
});

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:/.test(value)),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  WEB_ORIGIN: z.url(),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  ADMINS: z.string().default('admin'),
  WORKSPACE_ROOT: z.string().min(1).default('workspaces'),
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
    [result.data.BETTER_AUTH_URL, result.data.WEB_ORIGIN].some(
      (url) => !url.startsWith('https://'),
    )
  ) {
    throw new Error('生产环境 BETTER_AUTH_URL 和 WEB_ORIGIN 必须使用 HTTPS');
  }
  return result.data;
}
