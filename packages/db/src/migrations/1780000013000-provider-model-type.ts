import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProviderModelType1780000013000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE provider_models ADD COLUMN model_type text NOT NULL DEFAULT 'language'`,
    );
    await queryRunner.query(
      `ALTER TABLE provider_models ADD CONSTRAINT provider_models_model_type_check CHECK (model_type IN ('language', 'embedding', 'rerank', 'speech', 'image'))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE provider_models DROP COLUMN model_type`,
    );
  }
}
