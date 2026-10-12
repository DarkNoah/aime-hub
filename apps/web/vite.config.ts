import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {
  normalizeWebOrigins,
  webOriginsEnvSchema,
} from '../../packages/shared/src/web-origins';

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('../../', import.meta.url));
  const rootEnv = loadEnv(mode, envDir, ['SERVER_', 'WEB_']);
  const serverPort = rootEnv.SERVER_PORT ?? '3001';
  const webUrl = new URL(rootEnv.WEB_ORIGIN ?? 'http://127.0.0.1:5173');
  const webOrigins = normalizeWebOrigins([
    webUrl.origin,
    ...webOriginsEnvSchema.parse(rootEnv.WEB_ORIGINS),
  ]);

  return {
    envDir,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'dev-entry-url',
        apply: 'serve',
        configureServer(server) {
          const printUrls = server.printUrls.bind(server);
          server.printUrls = () => {
            printUrls();
            // VS Code must open the same origin used by authentication.
            server.config.logger.info(`Web entry: ${webUrl.origin}`);
          };
        },
      },
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: rootEnv.WEB_HOST ?? '0.0.0.0',
      port: Number(webUrl.port || (webUrl.protocol === 'https:' ? 443 : 80)),
      allowedHosts: webOrigins.map((origin) => new URL(origin).hostname),
      strictPort: true,
      proxy: {
        // Auth, RPC, SSE and file requests all share the browser's origin.
        '/api': {
          target: `http://127.0.0.1:${serverPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
