import { randomInt } from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
// The same SQL-safe nanoid alphabet as runtime table names.
const nanoid = () =>
  Array.from(
    { length: 16 },
    () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(36)],
  ).join('');
export class KnowledgeUnifiedVectors1780000019000 implements MigrationInterface {
  name = 'KnowledgeUnifiedVectors1780000019000';
  async up(q: QueryRunner) {
    await q.query(
      "SELECT pg_advisory_xact_lock(hashtext('knowledge-import-worker'), hashtext(current_schema()))",
    );
    await q.query(
      'LOCK TABLE knowledge_bases, knowledge_documents, knowledge_chunks IN ACCESS EXCLUSIVE MODE',
    );
    const [running] = await q.query(
      "SELECT count(*)::int AS count FROM knowledge_bases WHERE rebuild->>'status' IN ('pending', 'processing')",
    );
    if (running.count)
      throw new Error(
        'Wait for knowledge rebuilds before migrating vector storage',
      );
    await q.query('CREATE EXTENSION IF NOT EXISTS vector');
    await q.query(
      "ALTER TABLE knowledge_bases ADD COLUMN fields jsonb NOT NULL DEFAULT '[]'::jsonb",
    );
    await q.query(`CREATE FUNCTION knowledge_guard_vector() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target text; active_name text;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          SELECT b.id, b.vector_index INTO target, active_name FROM knowledge_documents d JOIN knowledge_bases b ON b.id = d.base_id
          WHERE d.id = COALESCE(OLD.document_id, OLD.metadata->>'documentId');
          IF active_name = TG_TABLE_NAME THEN PERFORM knowledge_assert_writable(target); END IF;
        END IF;
        IF TG_OP <> 'DELETE' THEN
          SELECT b.id, b.vector_index INTO target, active_name FROM knowledge_documents d JOIN knowledge_bases b ON b.id = d.base_id
          WHERE d.id = COALESCE(NEW.document_id, NEW.metadata->>'documentId');
          IF active_name = TG_TABLE_NAME THEN PERFORM knowledge_assert_writable(target); END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`);
    const bases: {
      id: string;
      vector_index: string | null;
      vector_dimension: number | null;
    }[] = await q.query(
      'SELECT id, vector_index, vector_dimension FROM knowledge_bases',
    );
    for (const base of bases) {
      const dimension = base.vector_dimension ?? 0;
      const name = `knowledge_${nanoid()}_${dimension}`;
      const table = quote(name);
      const vectorType =
        dimension > 2000 && dimension <= 4000 ? 'halfvec' : 'vector';
      await q.query(`CREATE TABLE ${table} (
        id bigserial PRIMARY KEY, vector_id text NOT NULL, embedding ${vectorType}${dimension ? `(${dimension})` : ''},
        metadata jsonb DEFAULT '{}'::jsonb, namespace varchar(255) NOT NULL DEFAULT 'default',
        document_id text REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        position integer, chunk text, document_version integer,
        UNIQUE(namespace, vector_id)
      )`);
      const old = base.vector_index;
      const [exists] = old
        ? await q.query('SELECT to_regclass($1) IS NOT NULL AS value', [
            quote(old),
          ])
        : [{ value: false }];
      await q.query(
        `INSERT INTO ${table} (vector_id, document_id, position, chunk, document_version, embedding, metadata)
        SELECT c.id, c.document_id, c.position, c.text, d.version,
        ${exists.value ? `v.embedding::${vectorType}${dimension ? `(${dimension})` : ''}` : 'NULL'},
        jsonb_build_object('documentId', d.id)
        FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        ${exists.value ? `LEFT JOIN ${quote(old!)} v ON v.vector_id = c.id AND v.namespace = 'default'` : ''}
        WHERE d.base_id = $1`,
        [base.id],
      );
      const [count] = await q.query(
        `SELECT (SELECT count(*) FROM ${table}) = (SELECT count(*) FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id WHERE d.base_id = $1) AS valid`,
        [base.id],
      );
      if (!count.valid)
        throw new Error('Knowledge vector migration count mismatch');
      await q.query(
        `CREATE INDEX ${quote(name + '_document_idx')} ON ${table}(document_id)`,
      );
      if (dimension && dimension <= 4000)
        await q.query(
          `CREATE INDEX ${quote(name + '_vector_idx')} ON ${table} USING hnsw(embedding ${vectorType}_cosine_ops)`,
        );
      await q.query(
        `CREATE TRIGGER knowledge_vector_lock BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION knowledge_guard_vector()`,
      );
      await q.query(
        'UPDATE knowledge_bases SET vector_index = $2 WHERE id = $1',
        [base.id, name],
      );
      if (exists.value) await q.query(`DROP TABLE ${quote(old!)}`);
    }
    await q.query('DROP TABLE knowledge_chunks');
  }
  async down() {
    // Reverting would discard custom physical columns. Restore a database backup instead.
    throw new Error(
      'Unified knowledge vectors require a backup restore to roll back',
    );
  }
}
