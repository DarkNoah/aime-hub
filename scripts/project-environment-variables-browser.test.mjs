/** Real project environment UI + HTTP/RPC + PostgreSQL in an isolated schema. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import {
  createDataSource,
  Project,
  ProjectMember,
  CreateProjectTables1780000002000,
} from '@aime/db';
import { ProjectListState1780000003000 } from '../packages/db/src/migrations/1780000003000-project-list-state.ts';
import { CreateEnvironmentVariables1780000004000 } from '../packages/db/src/migrations/1780000004000-create-environment-variables.ts';
import { UserEnvironmentVariables1780000028000 } from '../packages/db/src/migrations/1780000028000-user-environment-variables.ts';
import { ProjectEnvironmentVariables1780000037000 } from '../packages/db/src/migrations/1780000037000-project-environment-variables.ts';
import { ProjectService } from '../apps/server/src/modules/projects/service.ts';
import { EnvironmentVariableService } from '../apps/server/src/modules/environment-variables/service.ts';
import { createApp } from '../apps/server/src/app.ts';

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
const { getRequestListener } = serverRequire('@hono/node-server');

test(
  'project environment UI persists CRUD, isolates navigation, preserves list state and fits mobile',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 },
  async (t) => {
    const schema = `project_env_ui_${randomBytes(8).toString('hex')}`;
    const connectionString = process.env.TEST_DATABASE_URL;
    const pool = new Pool({ connectionString });
    const database = createDataSource(connectionString).setOptions({
      schema,
      extra: { options: `-c search_path=${schema}` },
      migrations: [
        CreateProjectTables1780000002000,
        ProjectListState1780000003000,
        CreateEnvironmentVariables1780000004000,
        UserEnvironmentVariables1780000028000,
        ProjectEnvironmentVariables1780000037000,
      ],
    });
    const fixture = await mkdtemp(path.join(webRoot, '.project-env-test-'));
    const artifacts = path.resolve(
      '.local/artifacts/project-environment-variables',
    );
    await mkdir(artifacts, { recursive: true });
    let vite, browser;
    t.after(async () => {
      await browser
        ?.contexts()[0]
        ?.pages()[0]
        ?.screenshot({ path: path.join(artifacts, 'last.png'), fullPage: true })
        .catch(() => {});
      await browser?.close();
      await vite?.close();
      if (database.isInitialized) await database.destroy();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
      await rm(fixture, { recursive: true, force: true });
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await database.initialize();
    await database.runMigrations();
    const projectId = 'project000000001';
    const otherId = 'project000000002';
    for (const id of [projectId, otherId]) {
      await database
        .getRepository(Project)
        .save({ id, name: id, createdBy: 'owner' });
      await database.getRepository(ProjectMember).save([
        { projectId: id, userId: 'owner', role: 'owner' },
        { projectId: id, userId: 'member', role: 'member' },
      ]);
    }
    const variables = new EnvironmentVariableService(database);
    await variables.create(
      { name: 'OTHER_PROJECT_ONLY', value: 'other' },
      { projectId: otherId },
    );
    let userId = 'owner';
    let app;
    let listCalls = 0;
    const listener = getRequestListener((request) => {
      if (
        new URL(request.url).pathname.endsWith(
          '/projectEnvironmentVariables/list',
        )
      )
        listCalls++;
      return app.fetch(request);
    });
    await writeFile(
      path.join(fixture, 'entry.tsx'),
      `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link} from '@tanstack/react-router';
import {ProjectEnvironmentVariablesPage} from '/src/pages/projects/environment-variables-page';
import {initializeI18n} from '/src/i18n';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {Toaster} from '/src/components/ui/sonner';
import '/src/index.css';
const root=createRootRoute({component:()=> <main className="mx-auto max-w-5xl p-5"><nav className="mb-6 flex gap-4"><Link to="/projects/$projectId/environment-variables" params={{projectId:'${projectId}'}}>项目 A</Link><Link to="/projects/$projectId/environment-variables" params={{projectId:'${otherId}'}}>项目 B</Link></nav><Outlet/><Toaster/></main>});
const tree=root.addChildren([createRoute({getParentRoute:()=>root,path:'/projects/$projectId/environment-variables',component:ProjectEnvironmentVariablesPage}),createRoute({getParentRoute:()=>root,path:'/projects/$projectId',component:()=> <p>项目仪表盘</p>})]);
const router=createRouter({routeTree:tree});await initializeI18n();createRoot(document.getElementById('root')).render(<ThemeProvider><RouterProvider router={router}/></ThemeProvider>);`,
    );
    const entryUrl =
      '/' + path.relative(webRoot, path.join(fixture, 'entry.tsx'));
    vite = await createServer({
      root: webRoot,
      configFile: false,
      envFile: false,
      cacheDir: path.join(fixture, 'node_modules/.vite'),
      resolve: {
        alias: { '@': path.join(webRoot, 'src') },
        dedupe: ['react', 'react-dom'],
      },
      plugins: [
        react(),
        tailwindcss(),
        {
          name: 'project-env-fixture',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (req.url.startsWith('/api/')) return listener(req, res);
              if (!req.url.startsWith('/projects/')) return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                await server.transformIndexHtml(
                  '/',
                  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="root"></div><script type="module" src="' +
                    entryUrl +
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
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    app = createApp(
      {
        api: {
          getSession: async () => ({ user: { id: userId, role: 'user' } }),
        },
      },
      undefined,
      { projects: new ProjectService(database), webOrigin: origin },
      undefined,
      { service: variables, webOrigin: origin },
    );
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/projects/${projectId}/environment-variables`);
    await page.getByText('还没有环境变量', { exact: true }).waitFor();
    const initialLists = listCalls;
    await page.getByRole('button', { name: '新增变量', exact: true }).click();
    await page.locator('#variable-name').fill('PROJECT_API_KEY');
    await page.locator('#variable-value').fill('synthetic-project-value');
    assert.equal(
      await page.locator('#variable-value').getAttribute('type'),
      'password',
    );
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page
      .getByRole('button', { name: '编辑 PROJECT_API_KEY', exact: true })
      .waitFor();
    assert.equal(listCalls, initialLists);
    assert.equal(
      (await variables.list({ projectId }))[0].value,
      'synthetic-project-value',
    );
    await page.reload();
    await page
      .getByRole('button', { name: '编辑 PROJECT_API_KEY', exact: true })
      .waitFor();
    await page
      .getByRole('textbox', { name: '搜索变量名或说明…' })
      .fill('PROJECT_API');
    await page
      .getByRole('button', { name: '编辑 PROJECT_API_KEY', exact: true })
      .click();
    await page.locator('#variable-multiline').click();
    await page.locator('#variable-value').fill('  line one\nline two  ');
    const beforeEdit = listCalls;
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(listCalls, beforeEdit);
    assert.equal(
      await page
        .getByRole('textbox', { name: '搜索变量名或说明…' })
        .inputValue(),
      'PROJECT_API',
    );
    assert.equal(
      (await variables.list({ projectId }))[0].value,
      '  line one\nline two  ',
    );
    await page.screenshot({
      path: path.join(artifacts, 'desktop.png'),
      fullPage: true,
    });
    await page.getByRole('link', { name: '项目 B', exact: true }).click();
    await page
      .getByRole('button', { name: '编辑 OTHER_PROJECT_ONLY', exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: '编辑 PROJECT_API_KEY', exact: true })
        .count(),
      0,
    );
    await page.getByRole('link', { name: '项目 A', exact: true }).click();
    await page
      .getByRole('button', { name: '编辑 PROJECT_API_KEY', exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: path.join(artifacts, 'mobile.png'),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: '删除 PROJECT_API_KEY', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '删除变量', exact: true })
      .click();
    await page.getByText('还没有环境变量', { exact: true }).waitFor();
    assert.deepEqual(await variables.list({ projectId }), []);
    userId = 'member';
    await page.reload();
    await page.getByRole('alert').waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: '新增变量', exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole('button', { name: '编辑 OTHER_PROJECT_ONLY', exact: true })
        .count(),
      0,
    );
    assert.deepEqual(errors, []);
  },
);
