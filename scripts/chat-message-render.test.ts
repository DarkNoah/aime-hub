import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

// Keep the real component, React context and JSX aliases in one frontend module graph.
await tsImport('../apps/web/src/components/chat/chat-messages.test.ts', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(
    new URL('../apps/web/tsconfig.json', import.meta.url),
  ),
});
