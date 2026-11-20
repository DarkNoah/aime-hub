import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PostgresStore } from '@mastra/pg';
import { Pool } from 'pg';
import { DataSource } from 'typeorm';
import { Setting } from '@aime/db';
import { TABLE_AGENT_VERSIONS } from '@mastra/core/storage';
import { migrateAgentSkillReferences } from './skill-reference-migration.js';

test(
  'skill path migration preserves every native Agent version and only rewrites exact global selections',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `agent_skill_migration_${randomBytes(8).toString('hex')}`;
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    const database = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
      schema,
      entities: [Setting],
    });
    t.after(async () => {
      if (database.isInitialized) await database.destroy();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await database.initialize();
    await database.synchronize();
    const storage = new PostgresStore({ id: schema, pool, schemaName: schema });
    const store = (await storage.getStore('agents'))!;
    await store.init();
    const oldArchive = '@local/bundle/alpha';
    const newArchive = 'bundle/alpha';
    const oldProject = 'owner/repo/project/skills/worker';
    const newProject = 'owner/repo/skills/worker';
    const metadata = { managedBy: 'admin-agents', configVersion: 1 };
    const workspace = (paths: string[], provider = 'installed-skills') => ({
      type: 'provider' as const,
      provider,
      config: {
        skillsMode: 'custom',
        skillPaths: paths,
        disabledTools: ['web_fetch'],
        agents: { writer: 'code:assistant' },
      },
    });
    const snapshot = {
      name: 'Migration fixture',
      instructions: `Keep this literal path in instructions: ${oldArchive}`,
      model: [],
      workspace: workspace([oldArchive, oldProject, `${oldArchive}-other`]),
    };
    const agent = await store.create({
      agent: { id: randomUUID(), metadata, ...snapshot },
    });
    const original = (await store.getLatestVersion(agent.id))!;
    await store.update({
      id: agent.id,
      status: 'published',
      activeVersionId: original.id,
    });
    const draft = await store.createVersion({
      ...snapshot,
      id: randomUUID(),
      agentId: agent.id,
      versionNumber: 2,
      workspace: workspace([newArchive, oldArchive]),
    });
    const otherProvider = await store.create({
      agent: {
        id: randomUUID(),
        metadata,
        ...snapshot,
        workspace: workspace([oldArchive], 'another-provider'),
      },
    });
    const unmanaged = await store.create({
      agent: {
        id: randomUUID(),
        ...snapshot,
        metadata: { managedBy: 'another-feature', configVersion: 1 },
      },
    });
    const newerConfig = await store.create({
      agent: {
        id: randomUUID(),
        ...snapshot,
        metadata: { ...metadata, configVersion: 2 },
      },
    });
    const malformedConfig = await store.create({
      agent: {
        id: randomUUID(),
        ...snapshot,
        metadata: { ...metadata, configVersion: '1' },
      },
    });
    const before = await store.getById(agent.id);
    const paths = new Map([
      [oldArchive, newArchive],
      [oldProject, newProject],
    ]);
    const migrationId = randomUUID();
    for (const scope of ['personal', 'project'] as const)
      assert.deepEqual(
        await migrateAgentSkillReferences(
          pool,
          { scope, paths, migrationId },
          schema,
        ),
        { agents: 0, versions: 0, references: 0 },
      );
    assert.deepEqual(await store.getVersion(original.id), original);
    assert.deepEqual(
      await migrateAgentSkillReferences(
        pool,
        { scope: 'global', paths, migrationId },
        schema,
      ),
      { agents: 1, versions: 2, references: 3 },
    );
    assert.deepEqual(await store.getById(agent.id), before);
    assert.deepEqual(await store.getVersion(original.id), {
      ...original,
      workspace: workspace([newArchive, newProject, `${oldArchive}-other`]),
    });
    assert.deepEqual(await store.getVersion(draft.id), {
      ...draft,
      workspace: workspace([newArchive]),
    });
    assert.equal(await store.countVersions(agent.id), 2);
    for (const untouched of [
      otherProvider,
      unmanaged,
      newerConfig,
      malformedConfig,
    ]) {
      const saved = (await store.getLatestVersion(untouched.id))!;
      assert.equal(saved.instructions, snapshot.instructions);
      assert.deepEqual(
        (saved.workspace as ReturnType<typeof workspace>).config.skillPaths,
        untouched.id === otherProvider.id
          ? [oldArchive]
          : [oldArchive, oldProject, `${oldArchive}-other`],
      );
    }
    assert.deepEqual(
      await migrateAgentSkillReferences(
        pool,
        { scope: 'global', paths, migrationId },
        schema,
      ),
      { agents: 0, versions: 0, references: 0 },
    );
    await assert.rejects(
      migrateAgentSkillReferences(
        pool,
        {
          scope: 'global',
          migrationId,
          paths: new Map([
            [newArchive, 'middle'],
            ['middle', 'final'],
          ]),
        },
        schema,
      ),
      /journal mismatch/,
    );
    assert.deepEqual(await store.getVersion(draft.id), {
      ...draft,
      workspace: workspace([newArchive]),
    });

    // Both entries are valid when a project contains project/foo and foo.
    // The journal prevents the first destination from being migrated a second time.
    const outer = 'owner/repo/project/project/foo';
    const inner = 'owner/repo/project/foo';
    const flat = 'owner/repo/foo';
    const overlapping = await store.create({
      agent: {
        id: randomUUID(),
        ...snapshot,
        metadata,
        workspace: workspace([outer, inner]),
      },
    });
    const overlapVersion = (await store.getLatestVersion(overlapping.id))!;
    const overlapMigration = {
      scope: 'global' as const,
      migrationId: randomUUID(),
      paths: new Map([
        [outer, inner],
        [inner, flat],
      ]),
    };
    const concurrent = await Promise.all([
      migrateAgentSkillReferences(pool, overlapMigration, schema),
      migrateAgentSkillReferences(pool, overlapMigration, schema),
    ]);
    assert.equal(
      concurrent.reduce((count, item) => count + item.references, 0),
      2,
    );
    assert.deepEqual(await store.getVersion(overlapVersion.id), {
      ...overlapVersion,
      workspace: workspace([inner, flat]),
    });
    assert.deepEqual(
      await migrateAgentSkillReferences(pool, overlapMigration, schema),
      { agents: 0, versions: 0, references: 0 },
    );

    // A failed transaction must not leave a completion marker that suppresses retry.
    const retryMigration = {
      scope: 'global' as const,
      migrationId: randomUUID(),
      paths: new Map([[inner, 'retry/foo']]),
    };
    await pool.query(`CREATE FUNCTION "${schema}".reject_migration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'migration fixture rollback'; END; $$`);
    await pool.query(
      `CREATE TRIGGER reject_migration BEFORE UPDATE ON "${schema}"."${TABLE_AGENT_VERSIONS}" FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_migration()`,
    );
    await assert.rejects(
      migrateAgentSkillReferences(pool, retryMigration, schema),
      /migration fixture rollback/,
    );
    assert.equal(
      (
        await pool.query('SELECT id FROM "settings" WHERE id = $1', [
          `skills:agent-path-migration:${retryMigration.migrationId}`,
        ])
      ).rowCount,
      0,
    );
    assert.deepEqual(await store.getVersion(overlapVersion.id), {
      ...overlapVersion,
      workspace: workspace([inner, flat]),
    });
    await pool.query(
      `DROP TRIGGER reject_migration ON "${schema}"."${TABLE_AGENT_VERSIONS}"`,
    );
    assert.deepEqual(
      await migrateAgentSkillReferences(pool, retryMigration, schema),
      { agents: 1, versions: 1, references: 1 },
    );
    assert.deepEqual(await store.getVersion(overlapVersion.id), {
      ...overlapVersion,
      workspace: workspace(['retry/foo', flat]),
    });
  },
);
