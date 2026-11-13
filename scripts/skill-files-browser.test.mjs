/** Real Skill API and production UI against an isolated temporary package. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { SkillService } from '../apps/server/src/modules/skills/service.ts';

const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const webRequire = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const serverRequire = createRequire(
  new URL('../apps/server/package.json', import.meta.url),
);
const load = (name) => import(pathToFileURL(webRequire.resolve(name)).href);
const [
  { createServer },
  { default: react },
  { default: tailwindcss },
  { default: playwright },
] = await Promise.all([
  load('vite'),
  load('@vitejs/plugin-react'),
  load('@tailwindcss/vite'),
  import(pathToFileURL(serverRequire.resolve('playwright-core')).href),
]);
const manifest = (description) =>
  `---\nname: research\ndescription: ${description}\n---\n# Research\n\nPackage instructions.\n`;

test(
  'skill editor browses, previews, preserves drafts, saves, detects conflicts and adapts to mobile',
  { timeout: 180000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(webRoot, '.skill-files-browser-'));
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), 'skill-files-browser-')),
    );
    const service = new SkillService(workspace);
    const root = path.join(
      service.forUser('admin').root,
      'owner/repo/research',
    );
    let vite, browser, app;
    const requests = [];
    t.after(async () => {
      await browser
        ?.contexts()[0]
        ?.pages()[0]
        ?.screenshot({ path: '/tmp/skill-files-last.png' })
        .catch(() => {});
      await browser?.close();
      await vite?.close();
      await service.dispose();
      await rm(fixture, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(
      path.join(root, 'SKILL.md'),
      manifest('Original description'),
    );
    await writeFile(path.join(root, 'scripts/run.py'), 'print("original")\n');
    await writeFile(path.join(root, 'sample.bin'), Buffer.from([0, 255, 1]));
    await writeFile(
      path.join(root, 'image.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    await writeFile(
      path.join(fixture, 'entry.tsx'),
      `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRouter,RouterProvider} from '@tanstack/react-router';
import {Toaster} from 'sonner';
import {SkillsManager} from '/src/components/skills/manager';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {initializeI18n} from '/src/i18n';
import '/src/index.css';
const route=createRootRoute({component:()=> <ThemeProvider><main style={{padding:24}}><SkillsManager scope="personal"/></main><Toaster/></ThemeProvider>});
const router=createRouter({routeTree:route});
await initializeI18n();
createRoot(document.getElementById('root')).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>);
`,
    );
    vite = await createServer({
      root: webRoot,
      configFile: false,
      envFile: false,
      cacheDir: path.join(fixture, 'node_modules/.vite'),
      resolve: {
        alias: { '@': path.join(webRoot, 'src') },
        dedupe: ['react', 'react-dom'],
      },
      optimizeDeps: { exclude: ['@tldraw/assets'] },
      plugins: [
        react(),
        tailwindcss(),
        {
          name: 'skill-files-browser-fixture',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (req.url?.startsWith('/api/')) {
                requests.push(req.url.split('?')[0]);
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const body = Buffer.concat(chunks);
                const response = await app.request(
                  new Request(new URL(req.url, `http://${req.headers.host}`), {
                    method: req.method,
                    headers: req.headers,
                    ...(body.length ? { body } : {}),
                  }),
                );
                res.statusCode = response.status;
                response.headers.forEach((value, key) =>
                  res.setHeader(key, value),
                );
                res.end(Buffer.from(await response.arrayBuffer()));
                return;
              }
              if (req.url !== '/') return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                await server.transformIndexHtml(
                  '/',
                  '<!doctype html><html><body><div id="root"></div><script type="module" src="/' +
                    path.relative(webRoot, path.join(fixture, 'entry.tsx')) +
                    '"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0 },
    });
    await vite.listen();
    const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
    app = createApp(
      {
        api: {
          getSession: async () => ({
            user: { id: 'admin', role: 'admin' },
            session: { id: 'fixture' },
          }),
        },
      },
      undefined,
      undefined,
      { service, webOrigin: origin },
    );
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    const editButton = page.getByRole('button', {
      name: 'Edit skill research',
      exact: true,
    });
    await editButton.waitFor();
    const listRequests = () =>
      requests.filter((url) => url === '/api/rpc/personalSkills/list').length;
    const beforeListRequests = listRequests();
    await editButton.click();
    const dialog = page.getByRole('dialog').first();
    await dialog
      .getByRole('treeitem', { name: 'SKILL.md', exact: true })
      .waitFor();
    await dialog.getByRole('tab', { name: 'Edit', exact: true }).click();
    const editor = dialog.getByRole('textbox', { name: 'Edit file contents' });
    await editor.fill(manifest('Updated in the editor'));
    await dialog
      .getByRole('treeitem', { name: 'scripts', exact: true })
      .press('ArrowRight');
    await dialog.getByRole('treeitem', { name: 'run.py', exact: true }).click();
    await dialog
      .getByRole('button', { name: 'Edit file', exact: true })
      .click();
    await editor.fill('print("edited script")\n');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('File contents saved.', { exact: true }).waitFor();
    assert.equal(
      await readFile(path.join(root, 'scripts/run.py'), 'utf8'),
      'print("edited script")\n',
    );
    await dialog
      .getByRole('treeitem', { name: 'SKILL.md', exact: true })
      .click();
    assert.equal(await editor.inputValue(), manifest('Updated in the editor'));
    await editor.press('ControlOrMeta+s');
    await dialog
      .getByRole('button', { name: 'Save', exact: true })
      .waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (el) => el.textContent.trim() === 'Save' && el.disabled,
      ),
    );
    assert.equal(
      await readFile(path.join(root, 'SKILL.md'), 'utf8'),
      manifest('Updated in the editor'),
    );
    assert.equal(
      listRequests(),
      beforeListRequests,
      'saving must not refetch/reset the whole skill catalog',
    );
    await editor.fill(manifest('Unsaved draft'));
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page
      .getByRole('button', { name: 'Keep editing', exact: true })
      .click();
    assert.equal(await editor.inputValue(), manifest('Unsaved draft'));
    await writeFile(path.join(root, 'SKILL.md'), manifest('External update'));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(
      await readFile(path.join(root, 'SKILL.md'), 'utf8'),
      manifest('External update'),
    );
    assert.equal(await editor.inputValue(), manifest('Unsaved draft'));
    await page.screenshot({ path: '/tmp/skill-files-desktop.png' });
    await dialog
      .getByRole('treeitem', { name: 'image.png', exact: true })
      .click();
    await dialog.locator('img').waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role=dialog] img')].some(
        (img) => img.complete && img.naturalWidth > 0,
      ),
    );
    await dialog
      .getByRole('treeitem', { name: 'sample.bin', exact: true })
      .click();
    await dialog
      .getByText(
        'This file type has no inline preview. Download it to open locally.',
      )
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog
      .getByRole('treeitem', { name: 'SKILL.md', exact: true })
      .click();
    await editor.waitFor();
    await page.screenshot({ path: '/tmp/skill-files-mobile.png' });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page
      .getByRole('button', { name: 'Discard changes', exact: true })
      .click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  },
);
