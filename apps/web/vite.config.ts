import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { webOriginsEnvSchema } from '../../packages/shared/src/web-origins';
import { moonshineAssets } from './build/moonshine-assets';
import { filePreviewAssets } from './build/file-preview-assets';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig(({ mode, command }) => {
  const envDir = fileURLToPath(new URL('../../', import.meta.url));
  const rootEnv = loadEnv(mode, envDir, ['SERVER_', 'WEB_']);
  const serverPort = rootEnv.SERVER_PORT ?? '3001';
  // Static Docker builds do not receive runtime environment configuration.
  const webOrigins = webOriginsEnvSchema.parse(
    rootEnv.WEB_ORIGINS ??
      (command === 'build' ? 'http://127.0.0.1:5173' : undefined),
  );
  const webUrl = new URL(webOrigins[0]);

  return {
    envDir,
    plugins: [
      react(),
      tailwindcss(),
      moonshineAssets(),
      filePreviewAssets(),
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
      dedupe: ['react', 'react-dom', '@tanstack/react-router'],
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    // Keep Vite's ?url handling for tldraw JSON translations and bundled assets.
    // Dependency prebundling otherwise turns translations into JSON objects.
    optimizeDeps: { exclude: ['@tldraw/assets'] },
    preview: { headers: isolationHeaders },
    server: {
      headers: isolationHeaders,
      host: rootEnv.WEB_HOST ?? '0.0.0.0',
      port: Number(webUrl.port || (webUrl.protocol === 'https:' ? 443 : 80)),
      allowedHosts: webOrigins.map((origin) => new URL(origin).hostname),
      strictPort: true,
      proxy: {
        // Auth, RPC, SSE and file requests all share the browser's origin.
        '/api': {
          target: `http://127.0.0.1:${serverPort}`,
          changeOrigin: false,
          configure(proxy) {
            proxy.on('proxyReq', (proxyReq, request) => {
              // Overwrite client-supplied values before Better Auth trusts them.
              proxyReq.setHeader(
                'X-Forwarded-Host',
                request.headers.host ?? webUrl.host,
              );
              proxyReq.setHeader('X-Forwarded-Proto', 'http');
            });
          },
        },
      },
    },
  };
});
