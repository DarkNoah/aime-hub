/** Production skill UI and real API with isolated archives and a deterministic GitHub source. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  mkdtemp,
  readFile,
  realpath,
  writeFile,
  rm,
  stat,
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
const { zipSync } = await import(
  pathToFileURL(serverRequire.resolve('fflate')).href
);
const manifest = (name, description = `${name} project entry`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Instructions\nUse the shared project sources.\n`;
const projectFiles = (version = 1) => ({
  'README.md': `Project version ${version}\n`,
  'pyproject.toml': '[project]\nname = "browser-project"\nversion = "1.0.0"\n',
  'src/main.py': `print("project version ${version}")\n`,
  'assets/shared.bin': Buffer.from([0, 255, 128, version]),
  'skills/alpha/SKILL.md': manifest('alpha', `Alpha version ${version}`),
  'skills/beta/SKILL.md': manifest('beta'),
  ...(version > 1 ? { 'skills/gamma/SKILL.md': manifest('gamma') } : {}),
});

test(
  'whole-project imports preserve shared sources, selected entries, scope isolation and project updates',
  { timeout: 240000 },
  async (t) => {
    const fixture = await mkdtemp(
      path.join(webRoot, '.skill-projects-browser-'),
    );
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), 'skill-projects-browser-')),
    );
    let version = 1;
    const downloads = [];
    const service = new SkillService(
      workspace,
      async (repository, _signal, original) => {
        downloads.push({ repository, original });
        const contents = projectFiles(version);
        return {
          commit: String(version).repeat(40),
          ref: 'main',
          scopePath: repository.kind === 'tree' ? 'skills/alpha' : '',
          files: Object.entries(contents).map(([name, value]) => ({
            path: name,
            oid: name,
            size: Buffer.byteLength(value),
            mode: '100644',
          })),
          read: async (file) => Buffer.from(contents[file.path]),
          dispose: async () => {},
        };
      },
    );
    let vite, browser, app;
    const requests = [];
    t.after(async () => {
      await browser
        ?.contexts()[0]
        ?.pages()[0]
        ?.screenshot({ path: '/tmp/skill-projects-last.png' })
        .catch(() => {});
      await browser?.close();
      await vite?.close();
      await service.dispose();
      await rm(fixture, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });
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
          name: 'skill-projects-browser-fixture',
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
    const openImport = async (archive = true) => {
      await page
        .getByRole('button', { name: 'Import skills', exact: true })
        .first()
        .click();
      const dialog = page.getByRole('dialog').first();
      if (archive)
        await dialog
          .getByRole('tab', { name: 'Archive file', exact: true })
          .click();
      return dialog;
    };
    const selectMode = async (dialog, name) => {
      await dialog
        .getByRole('combobox', { name: 'Import mode', exact: true })
        .click();
      await page.getByRole('option', { name, exact: true }).click();
    };
    const upload = (dialog, name) =>
      dialog.getByTestId('skill-archive-input').setInputFiles({
        name,
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync(
            Object.fromEntries(
              Object.entries(projectFiles()).map(([name, value]) => [
                `repository/${name}`,
                Buffer.from(value),
              ]),
            ),
          ),
        ),
      });
    const archiveResponse = (scope) =>
      page.waitForResponse(
        (response) =>
          response
            .url()
            .endsWith(
              scope === 'personal'
                ? '/api/skills/archives'
                : '/api/admin/skills/archives',
            ) && response.request().method() === 'POST',
      );
    const entry = (dialog, name) =>
      dialog.getByRole('checkbox', {
        name: `Select skill ${name}`,
        exact: true,
      });
    const installProject = async (dialog, name) => {
      await entry(dialog, name).check();
      await dialog
        .getByRole('button', { name: 'Import project', exact: true })
        .click();
      await dialog.waitFor({ state: 'hidden' });
      await page
        .getByRole('button', { name: `Edit skill ${name}`, exact: true })
        .waitFor();
    };
    const deleteProject = async (group) => {
      await page
        .getByRole('button', { name: `Delete project ${group}`, exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Delete this entire project?',
        exact: true,
      });
      await dialog.waitFor();
      assert.match(
        await dialog.innerText(),
        /every project file, shared resource/,
      );
      await dialog
        .getByRole('button', { name: 'Delete project', exact: true })
        .click();
      await dialog.waitFor({ state: 'hidden' });
    };
    const assertProjectFiles = async (
      root,
      group,
      currentVersion = 1,
      archivePrefix = '',
    ) => {
      for (const [name, value] of Object.entries(projectFiles(currentVersion)))
        assert.deepEqual(
          await readFile(
            path.join(root, group, 'project', archivePrefix, name),
          ),
          Buffer.from(value),
          name,
        );
    };

    // Switching import modes reuses the chosen file, clears selections and disposes each old scan.
    let dialog = await openImport();
    assert.equal(
      await dialog.getByRole('combobox', { name: 'Import mode' }).innerText(),
      'By skill',
    );
    let response = archiveResponse('personal');
    await upload(dialog, 'personal-project.zip');
    const ordinary = await (await response).json();
    await entry(dialog, 'alpha').check();
    response = archiveResponse('personal');
    const discarded = page.waitForResponse((response) =>
      response.url().includes('/api/rpc/personalSkills/discard'),
    );
    await selectMode(dialog, 'Whole project');
    const personalScan = await (await response).json();
    await discarded;
    await entry(dialog, 'alpha').waitFor();
    assert.equal(personalScan.importMode, 'project');
    assert.equal(
      personalScan.project.fileCount,
      Object.keys(projectFiles()).length,
    );
    assert.equal(await entry(dialog, 'alpha').isChecked(), false);
    assert.equal(
      await dialog
        .getByRole('button', { name: 'Import project', exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await dialog.getByText('personal-project.zip', { exact: true }).count(),
      2,
    );
    await assert.rejects(
      service.forUser('admin').install(ordinary.id, [ordinary.skills[0].path]),
      { code: 'SKILL_SCAN_EXPIRED' },
    );
    const personalLists = requests.filter(
      (url) => url === '/api/rpc/personalSkills/list',
    ).length;
    await page.screenshot({
      path: '/tmp/skill-projects-desktop.png',
      fullPage: true,
    });
    await installProject(dialog, 'alpha');
    assert.equal(
      requests.filter((url) => url === '/api/rpc/personalSkills/list').length,
      personalLists,
    );
    const personalGroup = '@local/personal-project';
    assert.deepEqual(
      (await service.forUser('admin').list()).skills.map((skill) => [
        skill.path,
        skill.projectRoot,
      ]),
      [[`${personalGroup}/project/skills/alpha`, `${personalGroup}/project`]],
    );
    await assertProjectFiles(service.forUser('admin').root, personalGroup, 1);
    assert.equal((await service.list()).skills.length, 0);
    assert.equal(
      await page
        .getByRole('button', { name: 'Remove alpha', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.getByRole('button', { name: /Update.*@local/ }).count(),
      0,
    );

    // A .skill project uses the same full-tree behavior in global scope on a mobile viewport.
    await page.getByRole('button', { name: 'Use global', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    dialog = await openImport();
    await selectMode(dialog, 'Whole project');
    response = archiveResponse('global');
    await upload(dialog, 'team-project.skill');
    const globalScan = await (await response).json();
    assert.equal(globalScan.importMode, 'project');
    await entry(dialog, 'beta').waitFor();
    await entry(dialog, 'beta').check();
    await page
      .locator('[data-sonner-toast]')
      .first()
      .waitFor({ state: 'hidden' });
    await page.screenshot({
      path: '/tmp/skill-projects-mobile.png',
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await installProject(dialog, 'beta');
    const globalGroup = '@local/team-project';
    assert.deepEqual(
      (await service.list()).skills.map((skill) => skill.path),
      [`${globalGroup}/project/skills/beta`],
    );
    await assertProjectFiles(service.root, globalGroup, 1);
    assert.equal(
      await page
        .getByRole('button', { name: 'Remove beta', exact: true })
        .count(),
      0,
    );
    await deleteProject(globalGroup);
    await assert.rejects(stat(path.join(service.root, globalGroup)), {
      code: 'ENOENT',
    });
    assert.equal((await service.forUser('admin').list()).skills.length, 1);

    // A folder URL still imports the whole repository, and updates preserve only the chosen entry set.
    await page.setViewportSize({ width: 1440, height: 1000 });
    dialog = await openImport(false);
    await dialog
      .getByRole('textbox', { name: 'GitHub source', exact: true })
      .fill('https://github.com/fixture/project/tree/main/skills/alpha');
    await entry(dialog, 'alpha').waitFor();
    assert.equal(await entry(dialog, 'beta').count(), 0);
    await selectMode(dialog, 'Whole project');
    await entry(dialog, 'beta').waitFor();
    await installProject(dialog, 'alpha');
    await assertProjectFiles(service.root, 'fixture/project');
    assert.equal(
      await page
        .getByRole('button', { name: 'Remove alpha', exact: true })
        .count(),
      0,
    );
    version = 2;
    const globalLists = requests.filter(
      (url) => url === '/api/rpc/skills/list',
    ).length;
    await page
      .getByRole('button', { name: 'Update fixture/project', exact: true })
      .click();
    await page.getByText('Alpha version 2', { exact: true }).waitFor();
    assert.equal(
      requests.filter((url) => url === '/api/rpc/skills/list').length,
      globalLists,
    );
    assert.deepEqual(
      (await service.list()).skills.map((skill) => [skill.path, skill.group]),
      [['fixture/project/project/skills/alpha', 'fixture/project']],
    );
    await assertProjectFiles(service.root, 'fixture/project', 2);
    assert.equal(downloads.length, 3);
    assert.deepEqual(
      downloads.map(({ repository }) => repository.refPath),
      ['main/skills/alpha', 'main/skills/alpha', undefined],
    );
    assert.equal(downloads[2].original.ref, 'main');
    assert.equal(downloads[2].original.scope, '');
    assert.deepEqual(downloads[2].original.installation.entries, [
      { path: 'skills/alpha/SKILL.md', name: 'alpha' },
    ]);
    await deleteProject('fixture/project');
    await assert.rejects(stat(path.join(service.root, 'fixture/project')), {
      code: 'ENOENT',
    });
    await page
      .getByRole('button', { name: 'Use personal', exact: true })
      .click();
    await deleteProject(personalGroup);
    await assert.rejects(
      stat(path.join(service.forUser('admin').root, personalGroup)),
      { code: 'ENOENT' },
    );
    assert.deepEqual((await service.list()).skills, []);
    assert.deepEqual((await service.forUser('admin').list()).skills, []);
    assert.deepEqual(errors, []);
  },
);
