// SENSEVOICE_TEST_MODEL_DIR must contain model.int8.onnx, tokens.txt,
// silero_vad.onnx and the official SenseVoice zh.wav fixture. Run with:
// SENSEVOICE_TEST_MODEL_DIR=/path/to/files node --import tsx --test scripts/sensevoice-browser.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { senseVoiceAssets } from '../apps/web/build/sensevoice-assets.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = path.join(root, 'apps/web');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const serverRequire = createRequire(
  path.join(root, 'apps/server/package.json'),
);
const { createServer } = await import(
  pathToFileURL(webRequire.resolve('vite')).href
);
const { chromium } = serverRequire('playwright-core');
const modelDir = process.env.SENSEVOICE_TEST_MODEL_DIR;

test(
  'SenseVoiceSmall: real WASM, microphone, final flush, cached reload and cancellation',
  {
    skip: !modelDir,
    timeout: 120000,
  },
  async (t) => {
    let vite, browser;
    t.after(async () => {
      await browser?.close();
      await vite?.close();
    });
    vite = await createServer({
      configFile: false,
      envFile: false,
      root: webRoot,
      cacheDir: path.join(root, '.tmp/sensevoice-vite'),
      optimizeDeps: { noDiscovery: true, entries: [] },
      plugins: [
        senseVoiceAssets(),
        {
          name: 'speech-test-fixtures',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (req.url === '/speech-test') {
                res.setHeader('Content-Type', 'text/html');
                res.end('<html><body>Speech test</body></html>');
                return;
              }
              const filename = req.url?.slice('/model/'.length);
              if (
                !req.url?.startsWith('/model/') ||
                ![
                  'model.int8.onnx',
                  'tokens.txt',
                  'silero_vad.onnx',
                  'zh.wav',
                ].includes(filename)
              )
                return next();
              const file = path.join(modelDir, filename);
              const size = (await stat(file)).size;
              res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': size,
                'Access-Control-Allow-Origin': '*',
              });
              createReadStream(file).pipe(res);
            });
          },
        },
      ],
      server: {
        watch: null,
        host: '127.0.0.1',
        port: 0,
        fs: { allow: [root] },
      },
    });
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        `--use-file-for-fake-audio-capture=${path.join(modelDir, 'zh.wav')}`,
      ],
    });
    const context = await browser.newContext();
    let downloads = 0;
    await context.route(
      /https:\/\/(huggingface.co|raw.githubusercontent.com)\//,
      async (route) => {
        downloads++;
        // Stream large weights over HTTP; passing them through CDP exceeds its
        // message limits. These are actual downloaded model bytes, not mock output.
        await route.fulfill({
          status: 302,
          headers: {
            location: `${base}/model/${new URL(route.request().url()).pathname.split('/').pop()}`,
            'access-control-allow-origin': '*',
          },
        });
      },
    );
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${base}/speech-test`);
    await page.evaluate(async () => {
      const { SenseVoiceSession } =
        await import('/src/components/audio/sensevoice-runtime.ts');
      const { SpeechInputController } =
        await import('/src/components/audio/speech-input-controller.ts');
      window.lines = [];
      window.failures = [];
      window.sessions = [];
      window.controller = new SpeechInputController(
        'zh',
        (callbacks) => {
          const session = new SenseVoiceSession(callbacks);
          window.sessions.push(session);
          return session;
        },
        (text) => window.lines.push(text),
        (error) => window.failures.push(String(error)),
      );
      await window.controller.start('草稿：');
    });
    assert.equal(
      await page.evaluate(() => window.controller.getSnapshot().status),
      'listening',
    );
    // Fake microphone feeds the real Chinese fixture through Web Audio/AudioWorklet.
    await new Promise((resolve) => setTimeout(resolve, 6500));
    assert.equal(await page.evaluate(() => window.controller.stop()), true);
    const result = await page.evaluate(() => ({
      text: window.lines.at(-1),
      failures: window.failures,
      state: window.controller.getSnapshot().status,
      mic: window.sessions[0].media
        .getTracks()
        .map((track) => track.readyState),
      audio: window.sessions[0].context.state,
    }));
    assert.match(result.text, /^草稿：.*早上9点至下午5点/);
    assert.deepEqual(result.failures, []);
    assert.equal(result.state, 'idle');
    assert.deepEqual(result.mic, ['ended']);
    assert.equal(result.audio, 'closed');
    assert.equal(downloads, 3);

    // Loading a fresh WASM worker reuses complete cached model downloads.
    await page.evaluate(async () => {
      await window.controller.start('第二次');
      window.controller.cancel();
    });
    assert.equal(downloads, 3);
    assert.equal(
      await page.evaluate(() => window.controller.getSnapshot().status),
      'idle',
    );

    // Cancelling load settles immediately and leaves the next draft untouched.
    await page.evaluate(async () => {
      const pending = window.controller.start('取消');
      window.controller.cancel();
      await pending;
    });
    assert.deepEqual(await page.evaluate(() => window.failures), []);
    assert.deepEqual(pageErrors, []);
    t.diagnostic(result.text);
  },
);
