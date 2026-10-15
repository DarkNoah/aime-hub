import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKnowledge1780000015000 implements MigrationInterface {
  name = 'CreateKnowledge1780000015000';
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE knowledge_bases (
      id text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
      scope text NOT NULL CHECK (scope IN ('shared','personal','project')), owner_id text NOT NULL,
      project_id text REFERENCES projects(id) ON DELETE CASCADE,
      embedding_model text, vector_dimension integer, enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((scope = 'project') = (project_id IS NOT NULL))
    )`);
    await q.query(
      'CREATE INDEX knowledge_bases_scope ON knowledge_bases(scope, owner_id, project_id)',
    );
    await q.query(`CREATE TABLE knowledge_documents (
      id text PRIMARY KEY, base_id text NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      name text NOT NULL, source_type text NOT NULL CHECK (source_type IN ('text','file','url')), source_url text,
      source_data bytea NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
      enabled boolean NOT NULL DEFAULT true, chunk_count integer NOT NULL DEFAULT 0, error text,
      content text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(
      'CREATE INDEX knowledge_documents_base ON knowledge_documents(base_id, created_at DESC, id)',
    );
    await q.query(
      "CREATE INDEX knowledge_documents_queue ON knowledge_documents(created_at) WHERE status IN ('pending','processing')",
    );
    await q.query(`CREATE TABLE knowledge_chunks (
      id text PRIMARY KEY, document_id text NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      position integer NOT NULL, text text NOT NULL, UNIQUE(document_id, position)
    )`);
  }
  async down(q: QueryRunner) {
    await q.query('DROP TABLE knowledge_chunks');
    await q.query('DROP TABLE knowledge_documents');
    await q.query('DROP TABLE knowledge_bases');
  }
}
