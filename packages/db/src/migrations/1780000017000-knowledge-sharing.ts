import type { MigrationInterface, QueryRunner } from 'typeorm';

export class KnowledgeSharing1780000017000 implements MigrationInterface {
  name = 'KnowledgeSharing1780000017000';
  async up(q: QueryRunner) {
    await q.query(
      'ALTER TABLE knowledge_documents ADD COLUMN source_name text',
    );
    await q.query(
      "UPDATE knowledge_documents SET source_name = name WHERE source_type = 'file'",
    );
    await q.query(`ALTER TABLE knowledge_bases
      ADD COLUMN sharing_mode text NOT NULL DEFAULT 'private' CHECK (sharing_mode IN ('private', 'all', 'members')),
      ADD COLUMN shared_permission text NOT NULL DEFAULT 'read' CHECK (shared_permission IN ('read', 'edit'))`);
    await q.query(
      "UPDATE knowledge_bases SET sharing_mode = 'all' WHERE scope = 'shared'",
    );
    await q.query(`CREATE TABLE knowledge_base_members (
      base_id text NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      user_id text NOT NULL, permission text NOT NULL CHECK (permission IN ('read', 'edit')),
      PRIMARY KEY(base_id, user_id)
    )`);
    await q.query(
      'CREATE INDEX knowledge_members_user ON knowledge_base_members(user_id, base_id)',
    );
    await q.query(
      'CREATE INDEX knowledge_bases_sharing ON knowledge_bases(sharing_mode)',
    );
    await q.query(`CREATE FUNCTION knowledge_guard_member() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP <> 'INSERT' THEN PERFORM knowledge_assert_writable(OLD.base_id); END IF;
        IF TG_OP <> 'DELETE' THEN PERFORM knowledge_assert_writable(NEW.base_id); END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`);
    await q.query(
      'CREATE TRIGGER knowledge_member_lock BEFORE INSERT OR UPDATE OR DELETE ON knowledge_base_members FOR EACH ROW EXECUTE FUNCTION knowledge_guard_member()',
    );
  }
  async down(q: QueryRunner) {
    await q.query('ALTER TABLE knowledge_documents DROP COLUMN source_name');
    await q.query('DROP TABLE knowledge_base_members');
    await q.query('DROP FUNCTION knowledge_guard_member()');
    await q.query('DROP INDEX knowledge_bases_sharing');
    await q.query(
      'ALTER TABLE knowledge_bases DROP COLUMN sharing_mode, DROP COLUMN shared_permission',
    );
  }
}
