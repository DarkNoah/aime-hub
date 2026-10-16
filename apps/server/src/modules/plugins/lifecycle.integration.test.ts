import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { DataSource } from 'typeorm';
import type { Auth } from '@aime/auth';
import {
  pluginManifestSchema,
  pluginConfigFieldsSchema,
  type PluginConfig,
} from '@app/plugin-sdk';
import type { InstalledPlugin, PluginServer } from '@app/plugin-sdk/server';
import { PluginService } from './service.js';
import { pluginRoutes } from './routes.js';
import { PluginConfiguration1780000022000 } from '../../../../../packages/db/src/migrations/1780000022000-plugin-configuration.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function definition(
  id: string,
  createServer: () => PluginServer,
  dependencies: string[] = [],
): InstalledPlugin {
  return {
    manifest: pluginManifestSchema.parse({
      id,
      name: id,
      description: '',
      version: '1.0.0',
      apiVersion: 1,
      dependencies,
    }),
    database: { entities: [], migrations: [] },
    createServer,
  };
}

const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => ({
      user: { id: 'test-user', role: headers.get('x-test-role') ?? 'admin' },
    }),
  },
} as unknown as Auth;
const origin = 'http://localhost:5173';
function toggle(service: PluginService, enabled: boolean, id = 'example') {
  return pluginRoutes(auth, service, [origin]).request(`/${id}/enabled`, {
    method: 'PUT',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

test(
  'plugin lifecycle with real PostgreSQL persistence and multiple runtimes',
  { skip: process.env.PLUGIN_INTEGRATION !== '1' },
  async (t) => {
    config({ quiet: true });
    const url = new URL(process.env.DATABASE_URL!);
    const name = `plugin_lifecycle_${process.pid}_${Date.now()}`;
    const admin = new Pool({ connectionString: url.href });
    let created = false;
    let database: DataSource | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      url.pathname = `/${name}`;
      const db = (database = new DataSource({
        type: 'postgres',
        url: url.href,
      }));
      await db.initialize();
      await db.query(`CREATE TABLE plugin_installations (
      id text PRIMARY KEY, version text NOT NULL, enabled boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
      await db.query(
        'CREATE TABLE plugin_migrations (plugin_id text, name text)',
      );
      const migrationRunner = db.createQueryRunner();
      try {
        await migrationRunner.connect();
        await new PluginConfiguration1780000022000().up(migrationRunner);
      } finally {
        await migrationRunner.release();
      }

      async function fixture(
        subtest: TestContext,
        definitions: InstalledPlugin[],
        initiallyEnabled = false,
        interval = 0,
      ) {
        await db.query('TRUNCATE plugin_installations');
        for (const { manifest } of definitions)
          await db.query(
            'INSERT INTO plugin_installations (id, version, enabled) VALUES ($1, $2, $3)',
            [manifest.id, manifest.version, initiallyEnabled],
          );
        const services: PluginService[] = [];
        const runtime = () => {
          const service = new PluginService(db, definitions, interval);
          services.push(service);
          return service;
        };
        subtest.after(async () => {
          await Promise.allSettled(
            services.map((service) => service.dispose()),
          );
        });
        return { service: runtime(), runtime };
      }
      const saved = async () =>
        (
          await db.query<{ enabled: boolean }[]>(
            'SELECT enabled FROM plugin_installations WHERE id = $1',
            ['example'],
          )
        )[0].enabled;

      await t.test(
        'startup restores in dependency order, repeated start is a no-op, shutdown preserves preferences',
        async (t) => {
          const events: string[] = [];
          const plugin = (id: string, deps: string[] = []) =>
            definition(
              id,
              () => ({
                onEnable: () => {
                  events.push(`${id}.enable`);
                },
                onDisable: () => {
                  events.push(`${id}.disable`);
                },
                dispose: async () => {
                  events.push(`${id}.dispose`);
                },
              }),
              deps,
            );
          const { service, runtime } = await fixture(
            t,
            [plugin('base'), plugin('example', ['base'])],
            true,
          );
          assert.deepEqual(events, []);
          assert.equal((await service.list())[0].enabled, false);
          await Promise.all([service.start(), service.start()]);
          assert.deepEqual(events, ['base.enable', 'example.enable']);
          await Promise.all([service.dispose(), service.dispose()]);
          assert.deepEqual(events, [
            'base.enable',
            'example.enable',
            'example.disable',
            'example.dispose',
            'base.disable',
            'base.dispose',
          ]);
          assert.equal(await saved(), true);
          const restarted = runtime();
          await restarted.start();
          assert.equal((await restarted.list())[1].enabled, true);
          assert.deepEqual(events.slice(-2), ['base.enable', 'example.enable']);
        },
      );

      await t.test(
        'API activation waits for readiness and concurrent duplicate toggles only invoke one callback',
        async (t) => {
          const entered = deferred();
          const finish = deferred();
          t.after(() => finish.resolve());
          let enables = 0;
          const { service } = await fixture(t, [
            definition('example', () => ({
              async onEnable() {
                enables++;
                entered.resolve();
                await finish.promise;
              },
            })),
          ]);
          await service.start();
          const first = toggle(service, true);
          const second = toggle(service, true);
          await entered.promise;
          assert.equal(await saved(), false);
          await assert.rejects(
            service.assertEnabled('example'),
            /PLUGIN_DISABLED/,
          );
          finish.resolve();
          assert.equal((await first).status, 200);
          assert.equal((await second).status, 200);
          assert.equal(enables, 1);
          assert.equal(await saved(), true);
          await service.assertEnabled('example');
        },
      );

      await t.test(
        'failed activation cleans partial resources and API reports the unchanged off state',
        async (t) => {
          let resources = 0;
          let fail = true;
          const { service } = await fixture(t, [
            definition('example', () => ({
              onEnable() {
                resources++;
                if (fail) throw new Error('private startup error');
              },
              onDisable() {
                resources = 0;
              },
            })),
          ]);
          await service.start();
          const response = await toggle(service, true);
          assert.equal(response.status, 409);
          const body = await response.json();
          assert.equal(body.code, 'PLUGIN_ENABLE_FAILED');
          assert.equal(body.plugin.enabled, false);
          assert.equal(body.plugin.desiredEnabled, false);
          assert.doesNotMatch(JSON.stringify(body), /private startup error/);
          assert.equal(await saved(), false);
          assert.equal(resources, 0);
          fail = false;
          assert.equal((await toggle(service, true)).status, 200);
          assert.equal(resources, 1);
        },
      );

      await t.test(
        'disable is persisted before cleanup and failures remain off until cleanup can retry',
        async (t) => {
          const entered = deferred();
          const finish = deferred();
          t.after(() => finish.resolve());
          let fail = true;
          let resources = 0;
          const { service, runtime } = await fixture(
            t,
            [
              definition('example', () => ({
                onEnable() {
                  resources++;
                },
                async onDisable() {
                  entered.resolve();
                  await finish.promise;
                  if (fail) throw new Error('stop failed');
                  resources--;
                },
              })),
            ],
            true,
          );
          await service.start();
          const other = runtime();
          await other.start();
          const stopping = toggle(service, false);
          await entered.promise;
          assert.equal(await saved(), false);
          await assert.rejects(
            other.assertEnabled('example'),
            /PLUGIN_DISABLED/,
          );
          finish.resolve();
          const response = await stopping;
          assert.equal(response.status, 409);
          const body = await response.json();
          assert.equal(body.code, 'PLUGIN_DISABLE_FAILED');
          assert.equal(body.plugin.enabled, false);
          assert.equal(body.plugin.desiredEnabled, false);
          assert.match(body.plugin.reason, /清理失败/);
          assert.equal(resources, 2);
          fail = false;
          await service.synchronize();
          await other.synchronize();
          assert.equal(resources, 0);
          assert.equal((await service.list())[0].reason, null);
          assert.equal((await toggle(service, false)).status, 200);
        },
      );

      await t.test(
        'restart failures preserve saved intent, isolate dependents, and recover on reconciliation',
        async (t) => {
          let fail = true;
          const events: string[] = [];
          const { service } = await fixture(
            t,
            [
              definition('base', () => ({
                onEnable() {
                  events.push('base.start');
                  if (fail) throw new Error('failed');
                },
                onDisable() {
                  events.push('base.stop');
                },
              })),
              definition(
                'example',
                () => ({
                  onEnable() {
                    events.push('example.start');
                  },
                }),
                ['base'],
              ),
            ],
            true,
          );
          await service.start();
          assert.deepEqual(events, ['base.start', 'base.stop']);
          assert.ok(
            (await service.list()).every(
              (state) => state.desiredEnabled && !state.enabled,
            ),
          );
          fail = false;
          await service.synchronize();
          assert.deepEqual(events.slice(-2), ['base.start', 'example.start']);
          assert.ok((await service.list()).every((state) => state.enabled));
          await assert.rejects(
            service.setEnabled('base', false),
            /PLUGIN_HAS_DEPENDENTS/,
          );
        },
      );

      await t.test(
        'another runtime notices missed off/on transitions and restarts resources and dependents',
        async (t) => {
          const events: string[] = [];
          let instance = 0;
          const { service, runtime } = await fixture(
            t,
            [
              definition('example', () => {
                const id = ++instance;
                return {
                  onEnable() {
                    events.push(`${id}.start`);
                  },
                  onDisable() {
                    events.push(`${id}.stop`);
                  },
                };
              }),
              definition(
                'dependent',
                () => ({
                  onEnable() {
                    events.push('dependent.start');
                  },
                  onDisable() {
                    events.push('dependent.stop');
                  },
                }),
                ['example'],
              ),
            ],
            true,
          );
          await service.start();
          const other = runtime();
          await other.start();
          await service.setEnabled('dependent', false);
          await service.setEnabled('example', false);
          await service.setEnabled('example', true);
          await service.setEnabled('dependent', true);
          assert.equal(
            (await other.list())[0].enabled,
            false,
            'stale generation is unavailable before reconciliation',
          );
          events.length = 0;
          await other.synchronize();
          assert.deepEqual(events, [
            'dependent.stop',
            '2.stop',
            '2.start',
            'dependent.start',
          ]);
          assert.ok((await other.list()).every((state) => state.enabled));
        },
      );

      await t.test(
        'failed database write after activation cleans resources and never publishes readiness',
        async (t) => {
          let resources = 0;
          const { service } = await fixture(t, [
            definition('example', () => ({
              onEnable() {
                resources++;
              },
              onDisable() {
                resources--;
              },
            })),
          ]);
          await service.start();
          await db.query(
            `CREATE FUNCTION reject_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.enabled THEN RAISE EXCEPTION 'write rejected'; END IF; RETURN NEW; END $$`,
          );
          await db.query(
            'CREATE TRIGGER reject_activation BEFORE UPDATE ON plugin_installations FOR EACH ROW EXECUTE FUNCTION reject_activation()',
          );
          try {
            const response = await toggle(service, true);
            assert.equal(response.status, 500);
            assert.equal((await response.json()).plugin.enabled, false);
            assert.equal(await saved(), false);
            assert.equal(resources, 0);
          } finally {
            await db.query(
              'DROP TRIGGER reject_activation ON plugin_installations',
            );
            await db.query('DROP FUNCTION reject_activation()');
          }
        },
      );

      await t.test(
        'failed disable persistence keeps existing resources available',
        async (t) => {
          let resources = 0;
          const { service } = await fixture(
            t,
            [
              definition('example', () => ({
                onEnable() {
                  resources++;
                },
                onDisable() {
                  resources--;
                },
              })),
            ],
            true,
          );
          await service.start();
          await db.query(
            `CREATE FUNCTION reject_disable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT NEW.enabled THEN RAISE EXCEPTION 'write rejected'; END IF; RETURN NEW; END $$`,
          );
          await db.query(
            'CREATE TRIGGER reject_disable BEFORE UPDATE ON plugin_installations FOR EACH ROW EXECUTE FUNCTION reject_disable()',
          );
          try {
            const response = await toggle(service, false);
            assert.equal(response.status, 500);
            const body = await response.json();
            assert.equal(body.plugin.enabled, true);
            assert.equal(body.plugin.desiredEnabled, true);
            assert.equal(await saved(), true);
            assert.equal(resources, 1);
            await service.assertEnabled('example');
          } finally {
            await db.query(
              'DROP TRIGGER reject_disable ON plugin_installations',
            );
            await db.query('DROP FUNCTION reject_disable()');
          }
        },
      );

      await t.test(
        'shutdown waits for in-flight activation, denies new work, and cleans resources once',
        async (t) => {
          const entered = deferred();
          const finish = deferred();
          t.after(() => finish.resolve());
          const events: string[] = [];
          const { service } = await fixture(t, [
            definition('example', () => ({
              async onEnable() {
                events.push('start');
                entered.resolve();
                await finish.promise;
              },
              onDisable() {
                events.push('stop');
              },
              dispose: async () => {
                events.push('dispose');
              },
            })),
          ]);
          await service.start();
          const enabling = toggle(service, true);
          await entered.promise;
          let disposed = false;
          const disposing = service.dispose().then(() => {
            disposed = true;
          });
          await delay(10);
          assert.equal(disposed, false);
          finish.resolve();
          assert.equal((await enabling).status, 503);
          await disposing;
          assert.equal(await saved(), false);
          assert.deepEqual(events, ['start', 'stop', 'dispose']);
          await assert.rejects(
            service.setEnabled('example', true),
            /PLUGIN_SERVICE_STOPPING/,
          );
        },
      );

      await t.test(
        'shutdown during restoration finishes the current callback without starting dependents',
        async (t) => {
          const entered = deferred();
          const finish = deferred();
          t.after(() => finish.resolve());
          const events: string[] = [];
          const { service } = await fixture(
            t,
            [
              definition('example', () => ({
                async onEnable() {
                  events.push('start');
                  entered.resolve();
                  await finish.promise;
                },
                onDisable() {
                  events.push('stop');
                },
              })),
              definition(
                'dependent',
                () => ({
                  onEnable() {
                    events.push('dependent.start');
                  },
                }),
                ['example'],
              ),
            ],
            true,
          );
          const starting = service.start();
          await entered.promise;
          service.beginShutdown();
          finish.resolve();
          await starting;
          assert.deepEqual(events, ['start']);
          await assert.rejects(
            service.assertEnabled('example'),
            /PLUGIN_DISABLED/,
          );
          await service.dispose();
          assert.deepEqual(events, ['start', 'stop']);
          assert.equal(await saved(), true);
        },
      );

      await t.test(
        'competing runtimes cannot enable while another runtime is still disabling',
        async (t) => {
          const entered = deferred();
          const finish = deferred();
          t.after(() => finish.resolve());
          const events: string[] = [];
          let instance = 0;
          const { service, runtime } = await fixture(
            t,
            [
              definition('example', () => {
                const id = ++instance;
                return {
                  onEnable() {
                    events.push(`${id}.start`);
                  },
                  async onDisable() {
                    events.push(`${id}.stop.begin`);
                    if (id === 1) {
                      entered.resolve();
                      await finish.promise;
                    }
                    events.push(`${id}.stop.end`);
                  },
                };
              }),
            ],
            true,
          );
          await service.start();
          const other = runtime();
          await other.start();
          events.length = 0;
          const disabling = toggle(service, false);
          await entered.promise;
          const enabling = toggle(other, true);
          await delay(20);
          assert.equal(await saved(), false);
          assert.deepEqual(events, ['1.stop.begin']);
          finish.resolve();
          assert.equal((await disabling).status, 200);
          assert.equal((await enabling).status, 200);
          assert.deepEqual(events, [
            '1.stop.begin',
            '1.stop.end',
            '2.stop.begin',
            '2.stop.end',
            '2.start',
          ]);
          await other.assertEnabled('example');
        },
      );

      await t.test(
        'configuration is admin-only, validated, persisted and passed as activation snapshots',
        async (t) => {
          const calls: { hook: string; config: PluginConfig }[] = [];
          const plugin = definition('example', () => ({
            onEnable({ config }) {
              calls.push({ hook: 'enable', config });
            },
            onDisable({ config }) {
              calls.push({ hook: 'disable', config });
            },
          }));
          plugin.manifest.configFields = pluginConfigFieldsSchema.parse([
            { key: 'token', label: 'Token', type: 'password', required: true },
            {
              key: 'limit',
              label: 'Limit',
              type: 'number',
              min: 1,
              max: 10,
              default: 3,
            },
          ]);
          const { service, runtime } = await fixture(t, [plugin]);
          const api = pluginRoutes(auth, service, [origin]);
          await service.start();
          const original = await service.getConfig('example');
          assert.deepEqual(original.config, { limit: 3 });
          assert.equal((await toggle(service, true)).status, 400);
          assert.deepEqual(calls, []);
          assert.equal(
            (
              await api.request('/example/config', {
                headers: { 'x-test-role': 'user' },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await api.request('/example/config', {
                method: 'PUT',
                headers: {
                  origin,
                  'content-type': 'application/json',
                  'x-test-role': 'user',
                },
                body: JSON.stringify(original),
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await api.request('/example/config', {
                method: 'PUT',
                headers: {
                  origin: 'https://untrusted.test',
                  'content-type': 'application/json',
                },
                body: JSON.stringify(original),
              })
            ).status,
            403,
          );
          const firstConfig = { token: 'test-secret-a', limit: 4 };
          const saved = await api.request('/example/config', {
            method: 'PUT',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify({
              config: firstConfig,
              revision: original.revision,
            }),
          });
          assert.equal(saved.status, 200);
          const savedBody = await saved.json();
          assert.equal(savedBody.applied, true);
          assert.deepEqual(
            calls,
            [],
            'saving a disabled plugin does not start resources',
          );
          assert.equal((await toggle(service, true)).status, 200);
          assert.deepEqual(calls, [{ hook: 'enable', config: firstConfig }]);
          for (const role of ['admin', 'user']) {
            const list = await (
              await api.request('/', { headers: { 'x-test-role': role } })
            ).json();
            assert.doesNotMatch(JSON.stringify(list), /test-secret/);
            assert.equal('config' in list[0], false);
            assert.equal('savedConfig' in list[0], false);
          }
          const current = await service.getConfig('example');
          const nextConfig = { token: 'test-secret-b', limit: 6 };
          const result = await service.setConfig(
            'example',
            nextConfig,
            current.revision,
          );
          assert.equal(result.applied, true);
          assert.deepEqual(calls, [
            { hook: 'enable', config: firstConfig },
            { hook: 'disable', config: firstConfig },
            { hook: 'enable', config: nextConfig },
          ]);
          await assert.rejects(
            service.setConfig('example', firstConfig, current.revision),
            /PLUGIN_CONFIG_CONFLICT/,
          );
          await assert.rejects(
            service.setConfig(
              'example',
              { ...nextConfig, limit: 11 },
              result.configuration.revision,
            ),
            /PLUGIN_CONFIG_INVALID/,
          );
          const unchanged = await service.setConfig(
            'example',
            { limit: 6, token: 'test-secret-b' },
            result.configuration.revision,
          );
          assert.equal(
            unchanged.configuration.revision,
            result.configuration.revision,
          );
          assert.equal(
            calls.length,
            3,
            'unchanged parameters do not restart resources',
          );
          const other = runtime();
          await other.start();
          const thirdConfig = { token: 'test-secret-c', limit: 7 };
          await service.setConfig(
            'example',
            thirdConfig,
            result.configuration.revision,
          );
          calls.length = 0;
          await other.synchronize();
          assert.deepEqual(calls, [
            { hook: 'disable', config: nextConfig },
            { hook: 'enable', config: thirdConfig },
          ]);
          await other.dispose();
          assert.deepEqual(calls.at(-1), {
            hook: 'disable',
            config: thirdConfig,
          });
          const restarted = runtime();
          await restarted.start();
          assert.deepEqual(calls.at(-1), {
            hook: 'enable',
            config: thirdConfig,
          });
        },
      );

      await t.test(
        'configuration changes restart dependents and preserve saved values after a callback failure',
        async (t) => {
          const calls: string[] = [];
          const plugin = definition('example', () => ({
            onEnable({ config }) {
              calls.push(`base.start:${config.value}`);
              if (config.value === 'bad') throw new Error('failed');
            },
            onDisable({ config }) {
              calls.push(`base.stop:${config.value}`);
            },
          }));
          plugin.manifest.configFields = pluginConfigFieldsSchema.parse([
            { key: 'value', label: 'Value', type: 'text', default: 'old' },
          ]);
          const dependent = definition(
            'dependent',
            () => ({
              onEnable() {
                calls.push('dependent.start');
              },
              onDisable() {
                calls.push('dependent.stop');
              },
            }),
            ['example'],
          );
          const { service } = await fixture(t, [plugin, dependent], true);
          await service.start();
          calls.length = 0;
          const failed = await service.setConfig(
            'example',
            { value: 'bad' },
            (await service.getConfig('example')).revision,
          );
          assert.equal(failed.applied, false);
          assert.equal(failed.plugin.desiredEnabled, true);
          assert.equal(failed.plugin.enabled, false);
          assert.deepEqual(failed.configuration.config, { value: 'bad' });
          assert.deepEqual(calls, [
            'dependent.stop',
            'base.stop:old',
            'base.start:bad',
            'base.stop:bad',
          ]);
          assert.ok((await service.list()).every((state) => !state.enabled));
          const fixed = await service.setConfig(
            'example',
            { value: 'fixed' },
            failed.configuration.revision,
          );
          assert.equal(fixed.applied, true);
          assert.deepEqual(calls.slice(-2), [
            'base.start:fixed',
            'dependent.start',
          ]);
          assert.ok((await service.list()).every((state) => state.enabled));
        },
      );

      await t.test(
        'polling stops another runtime without requiring an incoming request',
        async (t) => {
          let active = 0;
          const { service, runtime } = await fixture(
            t,
            [
              definition('example', () => ({
                onEnable() {
                  active++;
                },
                onDisable() {
                  active--;
                },
              })),
            ],
            true,
            20,
          );
          await service.start();
          const other = runtime();
          await other.start();
          assert.equal(active, 2);
          await service.setEnabled('example', false);
          const deadline = Date.now() + 3000;
          while (active && Date.now() < deadline) await delay(20);
          assert.equal(active, 0);
        },
      );
    } finally {
      if (database?.isInitialized) await database.destroy();
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
