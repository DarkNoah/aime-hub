import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import database from '../server/database.js';

test(
  'configuration migrations preserve credentials and carry the old endpoint into the list',
  { skip: process.env.QUANT_INTEGRATION !== '1' || !process.env.DATABASE_URL },
  async () => {
    const db = await new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    }).initialize();
    const runner = db.createQueryRunner();
    await runner.startTransaction();
    try {
      await runner.query(
        'CREATE TEMP TABLE plugin_installations (id text, config jsonb, updated_at timestamptz) ON COMMIT DROP',
      );
      await runner.query(
        'INSERT INTO plugin_installations VALUES ($1, $2, now())',
        [
          'vibe-quant',
          {
            engine: 'tdx',
            tdxHost: '192.0.2.5',
            tdxPort: 7719,
            pythonPath: '/obsolete/python',
            clickhousePassword: 'fixture-secret',
          },
        ],
      );
      for (const Migration of database.migrations.slice(1))
        await new Migration().up(runner);
      const [row] = await runner.query(
        'SELECT config FROM plugin_installations',
      );
      assert.equal(row.config.clickhousePassword, 'fixture-secret');
      assert.equal(row.config.tdxServers.split('\n')[0], '192.0.2.5:7719');
      assert.equal(row.config.tdxServers.split('\n').length, 9);
      assert.equal('pythonPath' in row.config, false);
      assert.equal('tdxHost' in row.config, false);
      assert.equal('tdxPort' in row.config, false);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
      await db.destroy();
    }
  },
);
