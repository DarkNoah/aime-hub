import { sessionStub } from './fixtures/thread-session.js';
import { createNodeServer } from '../apps/server/src/server.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { type Server } from 'node:http';
import { Pool } from 'pg';
import { createAuth, createAuthOptions } from '@aime/auth';
import { getMigrations } from '@aime/auth/migrations';
import {
  createDataSource,
  Provider,
  ProviderModel,
  Project,
  ProjectMember,
  Setting,
} from '@aime/db';
import { createApp } from '../apps/server/src/app.js';
import { ProjectService } from '../apps/server/src/modules/projects/service.js';
import { ProviderService } from '../apps/server/src/modules/providers/service.js';
import { LanguageModelService } from '../apps/server/src/modules/models/language-model.js';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import type { ProjectDetail } from '@aime/shared/projects';

test(
  'projects: PostgreSQL migrations, real auth, role permissions, defaults, membership revocation and HTTP isolation',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `projects_test_${randomBytes(8).toString('hex')}`;
    const connectionString = process.env.TEST_DATABASE_URL!;
    const options = `-c search_path=${schema}`;
    const root = new Pool({ connectionString });
    const pool = new Pool({ connectionString, options });
    const database = createDataSource(connectionString).setOptions({
      schema,
      extra: { options },
    });
    const browser = process.env.PROJECT_BROWSER_VERIFY === '1';
    const webOrigin = browser
      ? 'http://127.0.0.1:5175'
      : 'http://localhost:5173';
    let server: Server | undefined = undefined;
    let service: ThreadService | undefined = undefined;
    t.after(async () => {
      await service?.shutdown();
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await pool.end();
      if (database.isInitialized) await database.destroy();
      await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.end();
    });
    await root.query(`CREATE SCHEMA "${schema}"`);
    await database.initialize();
    await database.runMigrations();
    assert.equal((await database.runMigrations()).length, 0);
    const authOptions = createAuthOptions({
      pool,
      secret: randomBytes(32).toString('hex'),
      baseURL: webOrigin,
      webOrigin,
      admins: 'admin',
    });
    await (await getMigrations(authOptions)).runMigrations();
    const auth = createAuth({
      pool,
      secret: authOptions.secret as string,
      baseURL: webOrigin,
      webOrigin,
      admins: 'admin',
    });
    const users: Record<string, { id: string; cookie: string }> = {};
    for (const name of ['alice', 'bobby', 'carol', 'outsider', 'admin']) {
      const result = await auth.api.createUser({
        body: {
          name,
          email: `${name}@projects.example.test`,
          password: 'Project-Test-1234!',
          role: name === 'admin' ? 'admin' : 'user',
          data: { username: name },
        },
      });
      const login = await auth.api.signInUsername({
        body: { username: name, password: 'Project-Test-1234!' },
        asResponse: true,
      });
      assert.equal(login.status, 200);
      users[name] = {
        id: result.user.id,
        cookie: login.headers
          .getSetCookie()
          .map((item) => item.split(';')[0])
          .join('; '),
      };
    }
    const projects = new ProjectService(database);
    const providers = new ProviderService(database);
    const models = new LanguageModelService(database, providers);
    await database.manager.save(Provider, {
      id: 'fixture',
      name: 'Fixture',
      type: 'openai',
      baseUrl: 'http://localhost:1/v1',
      enabled: true,
    });
    for (const id of ['system', 'personal', 'project', 'explicit'])
      await database.manager.save(ProviderModel, {
        providerId: 'fixture',
        id,
        name: id,
        enabled: true,
        modalitiesInput: ['text'],
        modalitiesOutput: ['text'],
        reasoning: true,
        toolCall: false,
      });
    await providers.setDefaults({
      defaultModel: 'fixture/system',
      fastModel: null,
      imageModel: null,
      thinkingMode: 'medium',
    });
    const { memory } = fakeMemory();
    service = new ThreadService(
      memory,
      {
        async validate(userId, input, projectId) {
          await models.getLanguageModel(userId, input, projectId);
        },
        async createWorkspace(userId, projectId) {
          return `/test/${projectId ? `projects/${projectId}` : `users/${userId}/chat`}`;
        },
        async open({ onEvent }) {
          return sessionStub({
            async send(input) {
              onEvent({
                type: 'message',
                active: true,
                message: {
                  id: `reply-${input.id}`,
                  role: 'assistant',
                  parts: [
                    {
                      type: 'text',
                      text: 'Shared project reply from the local test fixture.',
                    },
                  ],
                },
              });
              onEvent({ type: 'status', status: 'success', runId: input.id });
            },
          });
        },
      },
      projects,
    );
    server = createNodeServer(
      createApp(
        auth,
        { service: providers, webOrigin },
        { threads: service, models, projects, webOrigin },
      ),
    ).listen(browser ? 4311 : 0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api`;
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      user = 'alice',
      origin = webOrigin,
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          cookie: users[user]?.cookie ?? '',
          origin,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const created = await request('/projects', 'POST', {
      name: 'Shared research',
    });
    assert.equal(created.status, 201);
    const project = (await created.json()) as ProjectDetail;
    assert.match(project.id, /^[\w-]{16}$/);
    assert.equal(project.role, 'owner');
    const path = `/projects/${project.id}`;
    assert.equal(
      (
        await database.manager.findOneByOrFail(ProjectMember, {
          projectId: project.id,
          userId: users.alice.id,
        })
      ).role,
      'owner',
    );
    if (browser) {
      await projects.addMember(users.alice.id, project.id, {
        userId: users.bobby.id,
        role: 'member',
      });
      for (let i = 1; i <= 12; i++) {
        const item =
          i === 1
            ? project
            : await projects.create(users.alice.id, {
                name: `协作项目 ${String(i).padStart(2, '0')}`,
              });
        for (let j = 1; j <= 12; j++)
          await service.createThread(users.alice.id, {
            projectId: item.id,
            model: null,
            reasoningEffort: 'auto',
            title: `需求讨论 ${String(j).padStart(2, '0')}`,
          });
      }
      console.log(
        'Project browser fixture ready: API 4311, web origin 5175. Sign in as alice / Project-Test-1234!.',
      );
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      return;
    }
    await t.test(
      'project storage configuration persists while rename and preferences preserve it',
      async () => {
        const configs = [
          { mode: 'simple', provider: 'local' },
          { mode: 'simple', provider: 'agentfs' },
          {
            mode: 'composite',
            mounts: [
              { provider: 'local', mountPath: 'local' },
              {
                provider: 'agentfs',
                mountPath: 'archive',
              },
            ],
          },
        ];
        for (const workspace of configs) {
          const response = await request('/projects', 'POST', {
            name: 'Storage',
            workspace,
          });
          assert.equal(response.status, 201);
          const created = await response.json();
          assert.deepEqual(created.workspace, workspace);
          assert.equal(
            (
              await request(`/projects/${created.id}`, 'PATCH', {
                name: 'Renamed',
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request(`/projects/${created.id}/preferences`, 'PUT', {
                model: null,
                reasoningEffort: 'auto',
              })
            ).status,
            200,
          );
          assert.deepEqual(
            (await projects.get(users.alice.id, created.id)).workspace,
            workspace,
          );
          await projects.remove(users.alice.id, created.id);
        }
        const invalid = await request('/projects', 'POST', {
          name: 'Invalid',
          workspace: {
            mode: 'composite',
            mounts: [
              { provider: 'local', mountPath: 'local' },
              {
                provider: 'agentfs',
                mountPath: 'data/nested',
              },
            ],
          },
        });
        assert.equal(invalid.status, 400);
        const legacy = await projects.create(users.alice.id, {
          name: 'Legacy',
        });
        await database.manager.update(
          Project,
          { id: legacy.id },
          { metadata: {} },
        );
        assert.deepEqual(
          (await projects.get(users.alice.id, legacy.id)).workspace,
          { mode: 'simple', provider: 'local' },
        );
        await projects.remove(users.alice.id, legacy.id);
      },
    );
    await t.test(
      'five-item project and thread pagination validates bounds and preserves scope',
      async () => {
        const created: ProjectDetail[] = [];
        for (let i = 0; i < 12; i++)
          created.push(
            await projects.create(users.outsider.id, { name: `Paged ${i}` }),
          );
        const seen: string[] = [];
        for (let page = 0; page < 3; page++) {
          const response = await request(
            `/projects?page=${page}&perPage=5`,
            'GET',
            undefined,
            'outsider',
          );
          assert.equal(response.status, 200);
          const result = await response.json();
          assert.equal(result.projects.length, page < 2 ? 5 : 2);
          assert.equal(result.hasMore, page < 2);
          seen.push(...result.projects.map((item: ProjectDetail) => item.id));
        }
        assert.equal(new Set(seen).size, 12);
        assert.deepEqual(
          new Set(seen),
          new Set(created.map((item) => item.id)),
        );
        const id = created[0].id;
        for (let i = 0; i < 12; i++)
          await service!.createThread(users.outsider.id, {
            projectId: id,
            model: null,
            reasoningEffort: 'auto',
            title: `Paged ${i}`,
          });
        const threadIds: string[] = [];
        for (let page = 0; page < 3; page++) {
          const response = await request(
            `/threads?projectId=${id}&page=${page}&perPage=5`,
            'GET',
            undefined,
            'outsider',
          );
          assert.equal(response.status, 200);
          const result = await response.json();
          assert.equal(result.threads.length, page < 2 ? 5 : 2);
          assert.equal(result.hasMore, page < 2);
          assert.ok(
            result.threads.every(
              (thread: { projectId: string }) => thread.projectId === id,
            ),
          );
          threadIds.push(
            ...result.threads.map((thread: { id: string }) => thread.id),
          );
        }
        assert.equal(new Set(threadIds).size, 12);
        assert.equal(
          (await request(`/threads?projectId=${id}&perPage=5`)).status,
          404,
        );
        assert.deepEqual(
          (
            await (
              await request('/threads?perPage=5', 'GET', undefined, 'outsider')
            ).json()
          ).threads,
          [],
        );
        for (const path of ['/projects', '/threads'])
          for (const perPage of ['0', '-1', '51', '1.5', 'bad']) {
            assert.equal(
              (await request(`${path}?perPage=${perPage}`)).status,
              400,
            );
          }
        for (const item of created)
          await projects.remove(users.outsider.id, item.id);
      },
    );
    await t.test(
      'authentication, CSRF, membership and account lookup are enforced',
      async () => {
        assert.equal(
          (await request('/projects', 'GET', undefined, 'anonymous')).status,
          401,
        );
        assert.equal(
          (
            await request(
              '/projects',
              'POST',
              { name: 'CSRF' },
              'alice',
              'https://attacker.example',
            )
          ).status,
          403,
        );
        assert.equal(
          (await request('/projects', 'POST', { name: ' ', metadata: {} }))
            .status,
          400,
        );
        for (const user of ['outsider', 'admin']) {
          assert.equal(
            (await request(path, 'GET', undefined, user)).status,
            404,
          );
          assert.equal(
            (await request(`${path}/users?q=bo`, 'GET', undefined, user))
              .status,
            404,
          );
          assert.equal(
            (await (await request('/projects', 'GET', undefined, user)).json())
              .projects.length,
            0,
          );
        }
        const candidates = await (await request(`${path}/users?q=bo`)).json();
        assert.equal(candidates.length, 1);
        assert.deepEqual(Object.keys(candidates[0]).sort(), [
          'id',
          'name',
          'username',
        ]);
        assert.equal(
          (
            await request(`${path}/members`, 'POST', {
              userId: users.bobby.id,
              role: 'member',
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await request(`${path}/members`, 'POST', {
              userId: users.carol.id,
              role: 'admin',
            })
          ).status,
          201,
        );
        assert.equal(
          (await request(`${path}/members`, 'POST', { userId: users.bobby.id }))
            .status,
          409,
        );
        assert.equal(
          (await request(`${path}/members/${users.alice.id}`, 'DELETE')).status,
          409,
        );
        assert.equal(
          (
            await request(
              `${path}/members/${users.bobby.id}`,
              'PATCH',
              { role: 'admin' },
              'carol',
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              `${path}/members`,
              'POST',
              { userId: users.outsider.id, role: 'admin' },
              'carol',
            )
          ).status,
          403,
        );
        assert.equal(
          (await request(`${path}/users?q=bo`, 'GET', undefined, 'bobby'))
            .status,
          403,
        );
        assert.equal(
          (await request(path, 'PATCH', { name: 'unauthorized' }, 'bobby'))
            .status,
          403,
        );
        assert.equal(
          (await request(path, 'PATCH', { name: 'Updated by admin' }, 'carol'))
            .status,
          200,
        );
      },
    );
    await t.test(
      'pins are personal and archives are shared, reversible, authorized and preserve project data',
      async () => {
        const item = await projects.create(users.alice.id, {
          name: 'Archive lifecycle',
        });
        const endpoint = `/projects/${item.id}`;
        assert.equal(item.archived, false);
        assert.equal(item.pinned, false);
        await projects.addMember(users.alice.id, item.id, {
          userId: users.bobby.id,
          role: 'member',
        });
        await projects.addMember(users.alice.id, item.id, {
          userId: users.carol.id,
          role: 'admin',
        });
        const conversation = await service!.createThread(users.alice.id, {
          projectId: item.id,
          model: null,
          reasoningEffort: 'auto',
          title: 'Retained conversation',
        });
        const pin = await request(
          `${endpoint}/pin`,
          'PATCH',
          { pinned: true },
          'bobby',
        );
        assert.equal(pin.status, 200);
        assert.equal((await pin.json()).pinned, true);
        assert.equal(
          (await new ProjectService(database).get(users.bobby.id, item.id))
            .pinned,
          true,
        );
        assert.equal(
          (await projects.get(users.alice.id, item.id)).pinned,
          false,
        );
        const page = await (
          await request('/projects?perPage=1', 'GET', undefined, 'bobby')
        ).json();
        assert.equal(page.projects[0].id, item.id);
        assert.equal(
          (
            await request(
              `${endpoint}/pin`,
              'PATCH',
              { pinned: true },
              'outsider',
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await request(
              `${endpoint}/pin`,
              'PATCH',
              { pinned: 'true' },
              'bobby',
            )
          ).status,
          400,
        );
        assert.equal(
          (await request(endpoint, 'PATCH', { archived: true }, 'bobby'))
            .status,
          403,
        );
        assert.equal(
          (await request(endpoint, 'PATCH', { archived: true }, 'outsider'))
            .status,
          404,
        );
        assert.equal(
          (
            await request(
              endpoint,
              'PATCH',
              { archived: true },
              'carol',
              'https://attacker.example',
            )
          ).status,
          403,
        );
        const archive = await request(
          endpoint,
          'PATCH',
          { archived: true },
          'carol',
        );
        assert.equal(archive.status, 200);
        assert.equal((await archive.json()).archived, true);
        for (const user of ['alice', 'bobby', 'carol']) {
          const active = await (
            await request('/projects', 'GET', undefined, user)
          ).json();
          assert.ok(
            active.projects.every(
              (entry: ProjectDetail) => entry.id !== item.id,
            ),
          );
          const archived = await (
            await request('/projects?status=archived', 'GET', undefined, user)
          ).json();
          assert.deepEqual(
            archived.projects.map((entry: ProjectDetail) => entry.id),
            [item.id],
          );
          const all = await (
            await request('/projects?status=all', 'GET', undefined, user)
          ).json();
          assert.ok(
            all.projects.some((entry: ProjectDetail) => entry.id === item.id),
          );
          const detail = await (
            await request(endpoint, 'GET', undefined, user)
          ).json();
          assert.equal(detail.archived, true);
          assert.deepEqual(detail.workspace, item.workspace);
          assert.deepEqual(detail.settings, item.settings);
          const chats = await (
            await request(
              `/threads?projectId=${item.id}`,
              'GET',
              undefined,
              user,
            )
          ).json();
          assert.equal(chats.threads[0].id, conversation.id);
        }
        const renamed = await request(endpoint, 'PATCH', {
          name: 'Archived rename',
        });
        assert.equal((await renamed.json()).archived, true);
        assert.equal((await request('/projects?status=invalid')).status, 400);
        assert.equal((await request(endpoint, 'PATCH', {})).status, 400);
        const restored = await request(endpoint, 'PATCH', { archived: false });
        assert.equal((await restored.json()).archived, false);
        assert.equal(
          (await projects.get(users.bobby.id, item.id)).pinned,
          true,
        );
        assert.ok(
          (await projects.list(users.bobby.id)).projects.some(
            (entry) => entry.id === item.id,
          ),
        );
        assert.equal(
          (
            await request(
              `${endpoint}/pin`,
              'PATCH',
              { pinned: false },
              'bobby',
            )
          ).status,
          200,
        );
        assert.equal(
          (await projects.get(users.bobby.id, item.id)).pinned,
          false,
        );
        await projects.remove(users.alice.id, item.id);
      },
    );
    await t.test(
      'project model precedence never inherits user defaults',
      async () => {
        await models.setPreferences(users.alice.id, {
          model: 'fixture/personal',
          reasoningEffort: 'low',
        });
        const defaults = { model: null, reasoningEffort: 'auto' } as const;
        assert.equal(
          (await models.getLanguageModel(users.alice.id, defaults, project.id))
            .reference,
          'fixture/system',
        );
        assert.equal(
          (await models.getLanguageModel(users.alice.id, defaults)).reference,
          'fixture/personal',
        );
        assert.equal(
          (
            await request(
              `${path}/preferences`,
              'PUT',
              { model: 'fixture/project', reasoningEffort: 'high' },
              'bobby',
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              `${path}/preferences`,
              'PUT',
              { model: 'fixture/project', reasoningEffort: 'high' },
              'carol',
            )
          ).status,
          200,
        );
        const resolved = await models.getLanguageModel(
          users.alice.id,
          defaults,
          project.id,
        );
        assert.equal(resolved.reference, 'fixture/project');
        assert.equal(resolved.providerOptions.openai?.reasoningEffort, 'high');
        assert.equal(
          (
            await models.getLanguageModel(
              users.alice.id,
              { model: 'fixture/explicit', reasoningEffort: 'none' },
              project.id,
            )
          ).reference,
          'fixture/explicit',
        );
        assert.equal(
          (
            await database.manager.findOneByOrFail(Setting, {
              id: `chat:user:${users.alice.id}`,
            })
          ).value && (await models.getPreferences(users.alice.id)).model,
          'fixture/personal',
        );
      },
    );
    await t.test(
      'shared threads isolate personal lists, revoke existing SSE, restore memberships and soft-delete projects',
      async () => {
        const thread = await (
          await request('/threads', 'POST', { projectId: project.id })
        ).json();
        assert.equal(thread.projectId, project.id);
        assert.equal(
          (await (await request('/threads')).json()).threads.length,
          0,
        );
        assert.equal(
          (
            await (
              await request(
                `/threads?projectId=${project.id}`,
                'GET',
                undefined,
                'bobby',
              )
            ).json()
          ).threads[0].id,
          thread.id,
        );
        for (const endpoint of [
          `/threads/${thread.id}`,
          `/threads/${thread.id}/history`,
          `/threads/${thread.id}/messages`,
        ])
          assert.equal(
            (await request(endpoint, 'GET', undefined, 'outsider')).status,
            404,
          );
        assert.equal(
          (await request(`/threads/${thread.id}`, 'DELETE', undefined, 'bobby'))
            .status,
          403,
        );
        const controller = new AbortController();
        const response = await fetch(`${base}/threads/${thread.id}/messages`, {
          headers: { cookie: users.bobby.cookie },
          signal: controller.signal,
        });
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let content = decoder.decode((await reader.read()).value);
        while (!content.includes('event: snapshot')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          content += decoder.decode(chunk.value);
        }
        assert.match(content, /event: snapshot/);
        assert.equal(
          (
            await request(
              `${path}/members/${users.bobby.id}`,
              'DELETE',
              undefined,
              'carol',
            )
          ).status,
          204,
        );
        while (!content.includes('revoked')) {
          const result = await reader.read();
          if (result.done) break;
          content += decoder.decode(result.value);
        }
        assert.match(content, /event: revoked/);
        controller.abort();
        assert.equal(
          (
            await request(
              `/threads/${thread.id}/messages`,
              'POST',
              { id: 'revoked01', parts: [{ type: 'text', text: 'rejected' }] },
              'bobby',
            )
          ).status,
          404,
        );
        const restored = await request(`${path}/members`, 'POST', {
          userId: users.bobby.id,
        });
        assert.equal(restored.status, 201);
        assert.ok((await restored.json()).createdAt);
        assert.equal(
          (await request(path, 'DELETE', undefined, 'carol')).status,
          403,
        );
        assert.equal((await request(path, 'DELETE')).status, 204);
        assert.equal((await request(path)).status, 404);
        assert.equal(
          (await request(`/threads/${thread.id}/history`)).status,
          404,
        );
        assert.ok(
          (
            await database.manager.findOne(Project, {
              where: { id: project.id },
              withDeleted: true,
            })
          )?.deletedAt,
        );
        assert.ok(
          await memory.getThreadById({ threadId: thread.id }),
          'soft deletion retains thread records',
        );
      },
    );
  },
);
