import { defineConfig } from 'tsup';
import { rm } from 'node:fs/promises';
import { copyBuiltinSkillFiles } from './src/modules/skills/builtin.js';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  noExternal: ['@aime/auth', '@aime/db', '@aime/shared'],
  external: ['typeorm', 'pg', 'reflect-metadata', 'dotenv', 'zod'],
  sourcemap: true,
  async onSuccess() {
    const destination = new URL('./dist/mastra/skills/', import.meta.url);
    await rm(destination, { recursive: true, force: true });
    await copyBuiltinSkillFiles(
      new URL('./src/mastra/skills/', import.meta.url),
      destination,
    );
  },
});
