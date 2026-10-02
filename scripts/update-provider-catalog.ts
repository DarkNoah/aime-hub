import { writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { z } from 'zod';

const response = await fetch('https://models.dev/api.json', {
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
const catalog = z
  .record(
    z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    z.object({ name: z.string().min(1) }),
  )
  .parse(await response.json());
if (!Object.hasOwn(catalog, 'openai') || Object.hasOwn(catalog, 'mineru'))
  throw new Error('Unexpected provider catalog; review before updating');
const providers = Object.fromEntries(
  Object.entries(catalog)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, value.name]),
);
const source = `// Generated from https://models.dev/api.json. Refresh: pnpm providers:catalog
// Snapshot: ${new Date().toISOString().slice(0, 10)}. Use top-level keys, not embedded provider IDs.
export const languageModelProviders = ${JSON.stringify(providers, null, 2)} as const;
`;
await writeFile(
  new URL('../packages/shared/src/provider-catalog.ts', import.meta.url),
  await format(source, { parser: 'typescript', singleQuote: true }),
);
console.log(
  `Updated ${Object.keys(providers).length} language model provider types.`,
);
