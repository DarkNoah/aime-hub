import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGeneratedAssetCreator1780000010000 implements MigrationInterface {
  name = 'AddGeneratedAssetCreator1780000010000';

  async up(queryRunner: QueryRunner) {
    await queryRunner.query(
      'ALTER TABLE generated_assets ADD COLUMN created_by text',
    );
    // Personal resources have a known owner. Historical project authors are unknown.
    await queryRunner.query(`UPDATE generated_assets
      SET created_by = substring(resource_id FROM 6)
      WHERE resource_id LIKE 'user:%' AND length(resource_id) > 5`);
  }

  async down(queryRunner: QueryRunner) {
    await queryRunner.query(
      'ALTER TABLE generated_assets DROP COLUMN created_by',
    );
  }
}
