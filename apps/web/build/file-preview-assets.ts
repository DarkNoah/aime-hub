import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { normalizePath } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export function filePreviewAssets() {
  const require = createRequire(import.meta.url);
  const pdfPackage = require.resolve('pdfjs-dist/package.json');
  const pdfDirectory = dirname(pdfPackage);
  const pdfVersion: string = require(pdfPackage).version;
  const modelDirectory = dirname(
    require.resolve('three/examples/jsm/libs/meshopt_decoder.module.js'),
  );

  return viteStaticCopy({
    targets: [
      ...['cmaps', 'standard_fonts', 'wasm'].map((directory) => ({
        src: normalizePath(join(pdfDirectory, directory, '*')),
        dest: `file-preview/pdfjs/${pdfVersion}/${directory}`,
        rename: { stripBase: true as const },
      })),
      {
        src: normalizePath(
          join(
            modelDirectory,
            'draco/gltf/draco_{decoder.js,decoder.wasm,wasm_wrapper.js}',
          ),
        ),
        dest: 'file-preview/model/draco',
        rename: { stripBase: true },
      },
      {
        src: normalizePath(
          join(modelDirectory, 'basis/basis_transcoder.{js,wasm}'),
        ),
        dest: 'file-preview/model/basis',
        rename: { stripBase: true },
      },
    ],
  });
}
