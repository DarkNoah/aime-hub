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
const { zipSync, strToU8 } = await import(
  pathToFileURL(serverRequire.resolve('fflate')).href
);
const manifest = (description) =>
  `---\nname: research\ndescription: ${description}\n---\n# Research\n\nPackage instructions.\n`;

test(
  'archive imports scan and install ZIP and SKILL packages in personal and global scopes',
  { timeout: 180000 },
  async (t) => {
    const fixture = await mkdtemp(
      path.join(webRoot, '.skill-archives-browser-'),
    );
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), 'skill-archives-browser-')),
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
        ?.screenshot({ path: '/tmp/skill-archives-last.png' })
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
function Demo(){const [scope,setScope]=React.useState('personal');return <ThemeProvider><main style={{padding:24}}><button onClick={()=>setScope('global')}>Use global</button><button onClick={()=>setScope('personal')}>Use personal</button><SkillsManager key={scope} scope={scope}/></main><Toaster/></ThemeProvider>};
const route=createRootRoute({component:Demo});
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
          name: 'skill-archives-browser-fixture',
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
    const openArchive = async () => {
      await page
        .getByRole('button', { name: 'Import skills', exact: true })
        .first()
        .click();
      const dialog = page.getByRole('dialog').first();
      await dialog
        .getByRole('tab', { name: 'Archive file', exact: true })
        .click();
      return dialog;
    };
    const upload = (dialog, name, files) =>
      dialog.getByTestId('skill-archive-input').setInputFiles({
        name,
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync(
            Object.fromEntries(
              Object.entries(files).map(([name, value]) => [
                name,
                strToU8(value),
              ]),
            ),
          ),
        ),
      });
    const skill = (name, description) =>
      `---\nname: ${name}\ndescription: ${description}\n---\n# Instructions\n`;
    const packageFiles = {
      'archive-demo/SKILL.md': skill(
        'archive-demo',
        'Imported archive package',
      ),
      'archive-demo/scripts/run.py': 'print("archive resource")\n',
      'archive-demo/nested/SKILL.md': skill(
        'nested',
        'Bundled nested instructions',
      ),
    };
    await page
      .getByRole('button', { name: 'Edit skill research', exact: true })
      .waitFor();
    const listRequests = () =>
      requests.filter((url) => url === '/api/rpc/personalSkills/list').length;
    const initialListRequests = listRequests();
    let dialog = await openArchive();
    await upload(dialog, 'research-pack.zip', packageFiles);
    const packageCheck = dialog.getByRole('checkbox', {
      name: 'Select skill archive-demo',
      exact: true,
    });
    await packageCheck.waitFor();
    assert.equal(
      await dialog
        .getByRole('checkbox', { name: 'Select skill nested', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await dialog.locator('a[href^="https://github.com"]').count(),
      0,
    );
    await packageCheck.check();
    await page.screenshot({
      path: '/tmp/skill-archives-desktop.png',
      fullPage: true,
    });
    await dialog
      .getByRole('button', { name: 'Install selected', exact: true })
      .click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByRole('button', { name: 'Edit skill archive-demo', exact: true })
      .waitFor();
    assert.equal(listRequests(), initialListRequests);
    assert.equal(
      await readFile(
        path.join(
          service.forUser('admin').root,
          '@local/research-pack/archive-demo/scripts/run.py',
        ),
        'utf8',
      ),
      'print("archive resource")\n',
    );
    assert.equal((await service.list()).skills.length, 0);
    assert.equal(
      await page.getByRole('button', { name: /Update.*@local/ }).count(),
      0,
    );

    // Existing destinations stay disabled; uploading a malformed package exposes an inline error.
    dialog = await openArchive();
    await upload(dialog, 'research-pack.zip', packageFiles);
    await dialog
      .getByRole('checkbox', { name: 'Select skill archive-demo', exact: true })
      .waitFor();
    assert.equal(
      await dialog
        .getByRole('checkbox', {
          name: 'Select skill archive-demo',
          exact: true,
        })
        .isDisabled(),
      true,
    );
    await dialog.getByTestId('skill-archive-input').setInputFiles({
      name: 'broken.skill',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('broken archive'),
    });
    await dialog.getByRole('alert').waitFor();
    assert.equal(
      await dialog
        .getByRole('button', { name: 'Install selected', exact: true })
        .isDisabled(),
      true,
    );
    await dialog
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
    await dialog.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: 'Use global', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    dialog = await openArchive();
    const scanResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/admin/skills/archives') &&
        response.request().method() === 'POST',
    );
    await upload(dialog, 'team.skill', {
      'catalog/alpha/SKILL.md': skill('alpha', 'Alpha archive skill'),
      'catalog/beta/SKILL.md': skill('beta', 'Beta archive skill'),
    });
    const scan = await (await scanResponse).json();
    await dialog
      .getByRole('checkbox', { name: 'Select skill alpha', exact: true })
      .waitFor();
    await dialog
      .getByRole('checkbox', { name: 'Select skill alpha', exact: true })
      .check();
    await page.screenshot({
      path: '/tmp/skill-archives-mobile.png',
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await dialog
      .getByRole('button', { name: 'Install selected', exact: true })
      .click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByRole('button', { name: 'Edit skill alpha', exact: true })
      .waitFor();
    assert.deepEqual(
      (await service.list()).skills.map((skill) => skill.path),
      ['@local/team/alpha'],
    );
    await assert.rejects(service.install(scan.id, [scan.skills[1].path]), {
      code: 'SKILL_SCAN_EXPIRED',
    });

    // Switching modes releases the temporary archive scan and clears the selectable results.
    dialog = await openArchive();
    const nextResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/admin/skills/archives') &&
        response.request().method() === 'POST',
    );
    await upload(dialog, 'cancelled.zip', {
      'SKILL.md': skill('cancelled', 'Discarded package'),
    });
    const cancelled = await (await nextResponse).json();
    await dialog
      .getByRole('checkbox', { name: 'Select skill cancelled', exact: true })
      .waitFor();
    const discarded = page.waitForResponse((response) =>
      response.url().includes('/api/rpc/skills/discard'),
    );
    await dialog.getByRole('tab', { name: 'GitHub', exact: true }).click();
    await discarded;
    assert.equal(
      await dialog
        .getByRole('checkbox', { name: 'Select skill cancelled', exact: true })
        .count(),
      0,
    );
    await assert.rejects(service.install(cancelled.id, ['SKILL.md']), {
      code: 'SKILL_SCAN_EXPIRED',
    });
    assert.deepEqual(errors, []);
  },
);
