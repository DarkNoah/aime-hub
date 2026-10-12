import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGeneratedAssetMetadata1780000011000 implements MigrationInterface {
  name = 'AddGeneratedAssetMetadata1780000011000';

  async up(queryRunner: QueryRunner) {
    await queryRunner.query(`ALTER TABLE generated_assets
      ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      CHECK (jsonb_typeof(metadata) = 'object')`);
    await queryRunner.query(`UPDATE generated_assets
      SET metadata = jsonb_strip_nulls(jsonb_build_object('width', width, 'height', height))`);
    await queryRunner.query(
      'ALTER TABLE generated_assets DROP COLUMN width, DROP COLUMN height',
    );
  }

  async down(queryRunner: QueryRunner) {
    await queryRunner.query(`ALTER TABLE generated_assets
      ADD COLUMN width integer CHECK (width > 0),
      ADD COLUMN height integer CHECK (height > 0)`);
    await queryRunner.query(`UPDATE generated_assets SET
      width = (metadata->>'width')::integer,
      height = (metadata->>'height')::integer`);
    await queryRunner.query(
      'ALTER TABLE generated_assets DROP COLUMN metadata',
    );
  }
}
