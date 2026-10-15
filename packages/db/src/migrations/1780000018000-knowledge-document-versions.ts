import type { MigrationInterface, QueryRunner } from 'typeorm';

export class KnowledgeDocumentVersions1780000018000 implements MigrationInterface {
  name = 'KnowledgeDocumentVersions1780000018000';
  async up(q: QueryRunner) {
    // Fence both the legacy worker and schema-scoped workers until migration commit.
    await q.query(
      "SELECT pg_advisory_xact_lock(hashtext('knowledge-import-worker'))",
    );
    await q.query(
      "SELECT pg_advisory_xact_lock(hashtext('knowledge-import-worker'), hashtext(current_schema()))",
    );
    await q.query(
      'LOCK TABLE knowledge_bases, knowledge_documents, knowledge_chunks IN ACCESS EXCLUSIVE MODE',
    );
    await q.query(`ALTER TABLE knowledge_documents
      ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN created_by text NOT NULL DEFAULT '',
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN deleted_at timestamptz,
      ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      ADD COLUMN version_created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN version_created_by text NOT NULL DEFAULT '',
      ADD COLUMN tags jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tags) = 'object')`);
    await q.query(`UPDATE knowledge_documents d SET version_created_at = d.created_at,
      version_created_by = b.owner_id, created_by = b.owner_id, updated_at = d.created_at FROM knowledge_bases b WHERE b.id = d.base_id`);
    await q.query(
      'CREATE INDEX knowledge_documents_archive ON knowledge_documents(base_id, deleted_at)',
    );
    await q.query(
      'CREATE INDEX knowledge_documents_tags ON knowledge_documents USING gin(tags)',
    );
    await q.query(`CREATE TABLE knowledge_document_versions (
      document_id text NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version > 0), name text NOT NULL,
      source_type text NOT NULL, source_name text, source_url text, source_data bytea NOT NULL,
      content text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, tags jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL, created_at timestamptz NOT NULL, created_by text NOT NULL,
      PRIMARY KEY(document_id, version)
    )`);
    await q.query(`CREATE TRIGGER knowledge_version_lock BEFORE INSERT OR UPDATE OR DELETE
      ON knowledge_document_versions FOR EACH ROW EXECUTE FUNCTION knowledge_guard_content()`);
  }
  async down(q: QueryRunner) {
    await q.query('DROP TABLE knowledge_document_versions');
    await q.query(
      'DROP INDEX knowledge_documents_tags, knowledge_documents_archive',
    );
    await q.query(
      'ALTER TABLE knowledge_documents DROP COLUMN metadata, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN deleted_at, DROP COLUMN version, DROP COLUMN version_created_at, DROP COLUMN version_created_by, DROP COLUMN tags',
    );
  }
}
