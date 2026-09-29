import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(
    mode,
    fileURLToPath(new URL('../../', import.meta.url)),
    'SERVER_',
  );
  const serverPort = process.env.SERVER_PORT ?? rootEnv.SERVER_PORT ?? '3001';

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${serverPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
