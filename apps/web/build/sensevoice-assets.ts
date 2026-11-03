import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Plugin } from 'vite';

// Preserve Emscripten's module-relative WASM URLs. Models are fetched lazily by
// the speech worker; only the small runtime is included in the frontend build.
export function senseVoiceAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const directories = Object.fromEntries(
    ['asr', 'vad'].map((name) => [
      name,
      dirname(require.resolve(`@sherpaw/${name}`)),
    ]),
  );
  const prefix = '/sensevoice/0.3.0/';
  const runtimeFile = /^(asr|vad)\/(?:prebuilt\/)?[\w.-]+\.(?:js|wasm)$/;
  return {
    name: 'sensevoice-assets',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path?.startsWith(prefix)) return next();
        const filename = path.slice(prefix.length);
        const match = runtimeFile.exec(filename);
        if (!match) return next();
        try {
          const body = await readFile(
            join(directories[match[1]], filename.slice(match[1].length + 1)),
          );
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
      for (const [name, directory] of Object.entries(directories)) {
        for (const filename of await readdir(directory, { recursive: true })) {
          if (!runtimeFile.test(`${name}/${filename}`)) continue;
          this.emitFile({
            type: 'asset',
            fileName: `${prefix.slice(1)}${name}/${filename}`,
            source: await readFile(join(directory, filename)),
          });
        }
        this.emitFile({
          type: 'asset',
          fileName: `${prefix.slice(1)}${name}/LICENSE`,
          source: await readFile(join(directory, '../LICENSE')),
        });
      }
    },
  };
}
