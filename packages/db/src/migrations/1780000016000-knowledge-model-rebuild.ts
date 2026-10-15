import type { MigrationInterface, QueryRunner } from 'typeorm';

export class KnowledgeModelRebuild1780000016000 implements MigrationInterface {
  name = 'KnowledgeModelRebuild1780000016000';
  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE knowledge_bases
      ADD COLUMN rerank_model text,
      ADD COLUMN vector_index text,
      ADD COLUMN rebuild jsonb,
      ADD COLUMN retired_indexes jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await q.query(
      `UPDATE knowledge_bases SET vector_index = 'kb_' || replace(id, '-', '') WHERE vector_dimension IS NOT NULL`,
    );
    await q.query(
      `UPDATE knowledge_bases SET rerank_model = (SELECT value->>'rerankModel' FROM settings WHERE id = 'models')`,
    );
    await q.query(
      `CREATE INDEX knowledge_bases_rebuild ON knowledge_bases ((rebuild->>'status')) WHERE rebuild IS NOT NULL`,
    );
    await q.query(`CREATE FUNCTION knowledge_assert_writable(target text) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE job jsonb;
      BEGIN
        SELECT rebuild INTO job FROM knowledge_bases WHERE id = target FOR UPDATE;
        IF job->>'status' IN ('pending', 'processing') THEN
          RAISE EXCEPTION 'KNOWLEDGE_LOCKED' USING ERRCODE = '55P03';
        END IF;
      END $$`);
    await q.query(`CREATE FUNCTION knowledge_guard_content() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE old_base text; new_base text;
      BEGIN
        IF TG_TABLE_NAME = 'knowledge_documents' THEN
          IF TG_OP <> 'INSERT' THEN old_base := OLD.base_id; END IF;
          IF TG_OP <> 'DELETE' THEN new_base := NEW.base_id; END IF;
        ELSE
          IF TG_OP <> 'INSERT' THEN SELECT base_id INTO old_base FROM knowledge_documents WHERE id = OLD.document_id; END IF;
          IF TG_OP <> 'DELETE' THEN SELECT base_id INTO new_base FROM knowledge_documents WHERE id = NEW.document_id; END IF;
        END IF;
        IF old_base IS NOT NULL THEN PERFORM knowledge_assert_writable(old_base); END IF;
        IF new_base IS NOT NULL AND new_base IS DISTINCT FROM old_base THEN PERFORM knowledge_assert_writable(new_base); END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE FUNCTION knowledge_guard_base() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.rebuild->>'status' IN ('pending', 'processing') THEN
          IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'KNOWLEDGE_LOCKED' USING ERRCODE = '55P03'; END IF;
          IF (to_jsonb(NEW) - 'rebuild' - 'retired_indexes') IS DISTINCT FROM (to_jsonb(OLD) - 'rebuild' - 'retired_indexes')
            AND (OLD.rebuild->>'attempt' IS NULL OR current_setting('knowledge.rebuild_commit', true) IS DISTINCT FROM OLD.rebuild->>'attempt')
          THEN RAISE EXCEPTION 'KNOWLEDGE_LOCKED' USING ERRCODE = '55P03'; END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`);
    await q.query(
      'CREATE TRIGGER knowledge_base_lock BEFORE UPDATE OR DELETE ON knowledge_bases FOR EACH ROW EXECUTE FUNCTION knowledge_guard_base()',
    );
    await q.query(
      'CREATE TRIGGER knowledge_document_lock BEFORE INSERT OR UPDATE OR DELETE ON knowledge_documents FOR EACH ROW EXECUTE FUNCTION knowledge_guard_content()',
    );
    await q.query(
      'CREATE TRIGGER knowledge_chunk_lock BEFORE INSERT OR UPDATE OR DELETE ON knowledge_chunks FOR EACH ROW EXECUTE FUNCTION knowledge_guard_content()',
    );
  }
  async down(q: QueryRunner) {
    await q.query('DROP TRIGGER knowledge_chunk_lock ON knowledge_chunks');
    await q.query(
      'DROP TRIGGER knowledge_document_lock ON knowledge_documents',
    );
    await q.query('DROP TRIGGER knowledge_base_lock ON knowledge_bases');
    await q.query(
      'DROP FUNCTION knowledge_guard_base(), knowledge_guard_content(), knowledge_assert_writable(text)',
    );
    await q.query('DROP INDEX knowledge_bases_rebuild');
    await q.query(
      'ALTER TABLE knowledge_bases DROP COLUMN retired_indexes, DROP COLUMN rebuild, DROP COLUMN vector_index, DROP COLUMN rerank_model',
    );
  }
}
