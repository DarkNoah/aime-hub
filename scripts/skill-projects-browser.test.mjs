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
const rootProjectFiles = (version = 1) => ({
  'SKILL.md': manifest('root-project', `Root version ${version}`),
  'README.md': 'Root project instructions\n',
  'src/main.py': `print("root project version ${version}")\n`,
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
        const contents =
          repository.repo === 'root-project'
            ? rootProjectFiles(version)
            : projectFiles(version);
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
        .getByRole('radiogroup', { name: 'Import mode', exact: true })
        .getByRole('radio', { name, exact: true })
        .check();
    };
    const upload = (dialog, name, files = projectFiles()) =>
      dialog.getByTestId('skill-archive-input').setInputFiles({
        name,
        mimeType: 'application/zip',
        buffer: Buffer.from(
          zipSync(
            Object.fromEntries(
              Object.entries(files).map(([name, value]) => [
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
      assert.equal(await entry(dialog, name).isChecked(), true);
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
          await readFile(path.join(root, group, archivePrefix, name)),
          Buffer.from(value),
          name,
        );
    };
    const assertProjectMetadata = async (root, group, sourceType) => {
      const metadata = path.join(root, group, '.skill-meta');
      assert.equal((await stat(metadata)).isDirectory(), true);
      const marker = JSON.parse(
        await readFile(path.join(metadata, '.skill-project.json'), 'utf8'),
      );
      assert.equal(marker.root, '.');
      await assert.rejects(stat(path.join(root, group, 'project')), {
        code: 'ENOENT',
      });
      for (const name of ['.skill-project.json', '.skill-sources.json'])
        await assert.rejects(stat(path.join(root, group, name)), {
          code: 'ENOENT',
        });
      if (sourceType === 'github')
        assert.equal(
          (await stat(path.join(metadata, '.skill-sources.json'))).isFile(),
          true,
        );
      else
        await assert.rejects(stat(path.join(metadata, '.skill-sources.json')), {
          code: 'ENOENT',
        });
    };

    // Ordinary imports start empty; switching to project mode selects every available entry.
    let dialog = await openImport();
    const importModes = dialog.getByRole('radiogroup', {
      name: 'Import mode',
      exact: true,
    });
    const bySkill = importModes.getByRole('radio', {
      name: 'By skill',
      exact: true,
    });
    const wholeProject = importModes.getByRole('radio', {
      name: 'Whole project',
      exact: true,
    });
    assert.equal(await bySkill.isChecked(), true);
    assert.equal(await wholeProject.isChecked(), false);
    await bySkill.focus();
    await page.keyboard.down('ArrowRight');
    await importModes
      .getByRole('radio', { name: 'Whole project', exact: true, checked: true })
      .waitFor();
    await page.keyboard.up('ArrowRight');
    await page.keyboard.down('ArrowLeft');
    await importModes
      .getByRole('radio', { name: 'By skill', exact: true, checked: true })
      .waitFor();
    await page.keyboard.up('ArrowLeft');
    let response = archiveResponse('personal');
    await upload(dialog, 'personal-project.zip');
    const ordinary = await (await response).json();
    await entry(dialog, 'alpha').waitFor();
    assert.equal(await entry(dialog, 'alpha').isChecked(), false);
    assert.equal(await entry(dialog, 'beta').isChecked(), false);
    assert.equal(
      await dialog
        .getByRole('button', { name: 'Install selected', exact: true })
        .isDisabled(),
      true,
    );
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
    assert.equal(personalScan.project.destination, 'personal-project');
    assert.equal(
      personalScan.project.fileCount,
      Object.keys(projectFiles()).length,
    );
    assert.equal(await entry(dialog, 'alpha').isChecked(), true);
    assert.equal(await entry(dialog, 'beta').isChecked(), true);
    assert.equal(
      await dialog
        .getByRole('button', { name: 'Import project', exact: true })
        .isDisabled(),
      false,
    );
    assert.equal(
      await dialog.getByText('personal-project.zip', { exact: true }).count(),
      2,
    );
    await assert.rejects(
      service.forUser('admin').install(ordinary.id, [ordinary.skills[0].path]),
      { code: 'SKILL_SCAN_EXPIRED' },
    );
    // A fresh archive scan resets a manual exclusion to the project default.
    await entry(dialog, 'alpha').uncheck();
    assert.equal(await entry(dialog, 'alpha').isChecked(), false);
    response = archiveResponse('personal');
    const projectDiscarded = page.waitForResponse((response) =>
      response.url().includes('/api/rpc/personalSkills/discard'),
    );
    await upload(dialog, 'personal-project.zip');
    const refreshedScan = await (await response).json();
    await projectDiscarded;
    await entry(dialog, 'alpha').waitFor();
    assert.notEqual(refreshedScan.id, personalScan.id);
    assert.equal(await entry(dialog, 'alpha').isChecked(), true);
    assert.equal(await entry(dialog, 'beta').isChecked(), true);
    await assert.rejects(
      service
        .forUser('admin')
        .install(personalScan.id, [personalScan.skills[0].path]),
      { code: 'SKILL_SCAN_EXPIRED' },
    );
    const personalLists = requests.filter(
      (url) => url === '/api/rpc/personalSkills/list',
    ).length;
    await page.screenshot({
      path: '/tmp/skill-projects-desktop.png',
      fullPage: true,
    });
    await entry(dialog, 'beta').uncheck();
    assert.equal(await entry(dialog, 'beta').isChecked(), false);
    await installProject(dialog, 'alpha');
    assert.equal(
      requests.filter((url) => url === '/api/rpc/personalSkills/list').length,
      personalLists,
    );
    const personalGroup = 'personal-project';
    assert.deepEqual(
      (await service.forUser('admin').list()).skills.map((skill) => [
        skill.path,
        skill.projectRoot,
        skill.sourceType,
      ]),
      [[`${personalGroup}/skills/alpha`, personalGroup, 'archive']],
    );
    await assertProjectFiles(service.forUser('admin').root, personalGroup, 1);
    await assertProjectMetadata(
      service.forUser('admin').root,
      personalGroup,
      'archive',
    );
    await page
      .getByRole('region', {
        name: 'Local archive / personal-project',
        exact: true,
      })
      .waitFor();
    assert.equal((await service.list()).skills.length, 0);
    assert.equal(
      await page
        .getByRole('button', { name: 'Remove alpha', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole('button', { name: `Update ${personalGroup}`, exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole('link', {
          name: `Open GitHub repository ${personalGroup}`,
          exact: true,
        })
        .count(),
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
    assert.equal(globalScan.project.destination, 'team-project');
    await entry(dialog, 'beta').waitFor();
    assert.equal(await entry(dialog, 'alpha').isChecked(), true);
    assert.equal(await entry(dialog, 'beta').isChecked(), true);
    await entry(dialog, 'alpha').uncheck();
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
    const globalGroup = 'team-project';
    assert.deepEqual(
      (await service.list()).skills.map((skill) => skill.path),
      [`${globalGroup}/skills/beta`],
    );
    await assertProjectFiles(service.root, globalGroup, 1);
    await assertProjectMetadata(service.root, globalGroup, 'archive');
    await page
      .getByRole('region', {
        name: 'Local archive / team-project',
        exact: true,
      })
      .waitFor();
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
    assert.equal(await entry(dialog, 'alpha').isChecked(), false);
    await selectMode(dialog, 'Whole project');
    await entry(dialog, 'beta').waitFor();
    assert.equal(await entry(dialog, 'alpha').isChecked(), true);
    assert.equal(await entry(dialog, 'beta').isChecked(), true);
    await entry(dialog, 'beta').uncheck();
    // The explicit GitHub rescan also starts with every project entry selected.
    const githubRescan = page.waitForResponse((response) =>
      response.url().includes('/api/rpc/skills/scan'),
    );
    await dialog.getByRole('button', { name: 'Scan', exact: true }).click();
    await githubRescan;
    await entry(dialog, 'beta').waitFor();
    assert.equal(await entry(dialog, 'alpha').isChecked(), true);
    assert.equal(await entry(dialog, 'beta').isChecked(), true);
    await entry(dialog, 'beta').uncheck();
    await installProject(dialog, 'alpha');
    await assertProjectFiles(service.root, 'fixture/project');
    await assertProjectMetadata(service.root, 'fixture/project', 'github');
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
      (await service.list()).skills.map((skill) => [
        skill.path,
        skill.group,
        skill.projectRoot,
        skill.sourceType,
      ]),
      [
        [
          'fixture/project/skills/alpha',
          'fixture/project',
          'fixture/project',
          'github',
        ],
      ],
    );
    await assertProjectFiles(service.root, 'fixture/project', 2);
    await assertProjectMetadata(service.root, 'fixture/project', 'github');
    assert.equal(downloads.length, 4);
    assert.deepEqual(
      downloads.map(({ repository }) => repository.refPath),
      [
        'main/skills/alpha',
        'main/skills/alpha',
        'main/skills/alpha',
        undefined,
      ],
    );
    assert.equal(downloads[3].original.ref, 'main');
    assert.equal(downloads[3].original.scope, '');
    assert.deepEqual(downloads[3].original.installation.entries, [
      { path: 'skills/alpha/SKILL.md', name: 'alpha' },
    ]);
    await deleteProject('fixture/project');
    await assert.rejects(stat(path.join(service.root, 'fixture/project')), {
      code: 'ENOENT',
    });
    // Root-entry projects expose source files in the editor, while app metadata stays hidden.
    dialog = await openImport();
    await selectMode(dialog, 'Whole project');
    response = archiveResponse('global');
    await upload(dialog, 'root-project.zip', rootProjectFiles());
    const rootScan = await (await response).json();
    assert.equal(rootScan.project.destination, 'root-project');
    await entry(dialog, 'root-project').waitFor();
    assert.equal(await entry(dialog, 'root-project').isChecked(), true);
    await installProject(dialog, 'root-project');
    await assertProjectMetadata(service.root, 'root-project', 'archive');
    assert.equal(
      await readFile(
        path.join(service.root, 'root-project', 'src/main.py'),
        'utf8',
      ),
      'print("root project version 1")\n',
    );
    await page
      .getByRole('button', { name: 'Edit skill root-project', exact: true })
      .click();
    const preview = page.getByRole('dialog', {
      name: 'root-project',
      exact: true,
    });
    await preview
      .getByRole('treeitem', { name: 'README.md', exact: true })
      .waitFor();
    await preview.getByRole('treeitem', { name: 'src', exact: true }).waitFor();
    for (const name of [
      '.skill-meta',
      '.skill-project.json',
      '.skill-sources.json',
    ])
      assert.equal(
        await preview.getByRole('treeitem', { name, exact: true }).count(),
        0,
      );
    await preview.getByRole('button', { name: 'Close', exact: true }).click();
    await preview.waitFor({ state: 'hidden' });
    await deleteProject('root-project');
    await assert.rejects(stat(path.join(service.root, 'root-project')), {
      code: 'ENOENT',
    });
    // Updating a root entry replaces its row too, even though its path is exactly the group.
    version = 1;
    dialog = await openImport(false);
    await selectMode(dialog, 'Whole project');
    await dialog
      .getByRole('textbox', { name: 'GitHub source', exact: true })
      .fill('fixture/root-project');
    await entry(dialog, 'root-project').waitFor();
    await installProject(dialog, 'root-project');
    version = 2;
    await page
      .getByRole('button', { name: 'Update fixture/root-project', exact: true })
      .click();
    await page.getByText('Root version 2', { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Edit skill root-project', exact: true })
        .count(),
      1,
    );
    assert.deepEqual(
      (await service.list()).skills.map((skill) => skill.path),
      ['fixture/root-project'],
    );
    await assertProjectMetadata(service.root, 'fixture/root-project', 'github');
    assert.equal(
      await readFile(
        path.join(service.root, 'fixture/root-project/src/main.py'),
        'utf8',
      ),
      'print("root project version 2")\n',
    );
    await deleteProject('fixture/root-project');
    await assert.rejects(
      stat(path.join(service.root, 'fixture/root-project')),
      { code: 'ENOENT' },
    );
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
