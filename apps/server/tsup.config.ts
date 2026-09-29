import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  noExternal: ['@aime/auth', '@aime/db', '@aime/shared'],
  external: ['typeorm', 'pg', 'reflect-metadata', 'dotenv', 'zod'],
  sourcemap: true,
});
