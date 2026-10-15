import type { MigrationInterface, QueryRunner } from 'typeorm';

export class KnowledgeDocumentMetadata1780000021000 implements MigrationInterface {
  name = 'KnowledgeDocumentMetadata1780000021000';

  async up(q: QueryRunner) {
    // Early installations ran the document-version migration before metadata
    // was added to it. A new migration is required for those existing databases.
    await q.query(`ALTER TABLE knowledge_documents
      ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await q.query(`ALTER TABLE knowledge_document_versions
      ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb`);
  }

  async down() {
    // These columns may predate this repair. Keep their data when rolling back;
    // the original document-version migration owns their removal.
  }
}
