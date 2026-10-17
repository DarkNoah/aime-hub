import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Plugin } from 'vite';

// Preserve the package's relative module/WASM/pthread URLs instead of bundling
// Emscripten's generated module. All runtime assets are served from our origin.
export function moonshineAssets(): Plugin {
  const directory = dirname(
    createRequire(import.meta.url).resolve(
      '@moonshine-ai/moonshine-wasm/moonshine.wasm',
    ),
  );
  const prefix = '/moonshine/0.1.5/';
  const runtimeFile = /^[\w.-]+\.(?:js|mjs|wasm)$/;
  return {
    name: 'moonshine-assets',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path?.startsWith(prefix)) return next();
        const filename = path.slice(prefix.length);
        if (!runtimeFile.test(filename)) return next();
        try {
          const body = await readFile(join(directory, filename));
          // This middleware precedes Vite's static handler, including its headers.
          for (const [name, value] of Object.entries(
            server.config.server.headers ?? {},
          )) {
            if (value !== undefined) response.setHeader(name, value);
          }
          response.setHeader(
            'Content-Type',
            filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
          );
          response.end(body);
        } catch {
          response.statusCode = 404;
          response.end();
        }
      });
    },
    async generateBundle() {
      for (const filename of await readdir(directory)) {
        if (!runtimeFile.test(filename)) continue;
        this.emitFile({
          type: 'asset',
          fileName: `${prefix.slice(1)}${filename}`,
          source: await readFile(join(directory, filename)),
        });
      }
    },
  };
}
