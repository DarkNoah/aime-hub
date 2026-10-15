import { defineConfig } from 'tsup';
import { rm } from 'node:fs/promises';
import { copyBuiltinSkillFiles } from './src/modules/skills/builtin.js';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  define: { __API_DOCS_ENABLED__: 'false' },
  noExternal: ['@aime/auth', '@aime/db', '@aime/shared', '@app/plugin-sdk'],
  external: ['typeorm', 'pg', 'reflect-metadata', 'dotenv', 'zod'],
  sourcemap: true,
  async onSuccess() {
    const pluginDestination = new URL(
      './dist/bundled-skills/',
      import.meta.url,
    );
    await rm(pluginDestination, { recursive: true, force: true });
    await copyBuiltinSkillFiles(
      new URL('./src/modules/plugins/bundled-skills/', import.meta.url),
      pluginDestination,
    );
    const destination = new URL('./dist/mastra/skills/', import.meta.url);
    await rm(destination, { recursive: true, force: true });
    await copyBuiltinSkillFiles(
      new URL('./src/mastra/skills/', import.meta.url),
      destination,
    );
  },
});
