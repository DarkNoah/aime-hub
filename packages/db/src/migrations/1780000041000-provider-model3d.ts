import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProviderModel3d1780000041000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE provider_models DROP CONSTRAINT provider_models_model_type_check',
    );
    await queryRunner.query(
      "ALTER TABLE provider_models ADD CONSTRAINT provider_models_model_type_check CHECK (model_type IN ('language', 'embedding', 'rerank', 'speech', 'asr', 'image', 'ocr', 'model3d'))",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse rollback while 3D models exist instead of deleting their configuration.
    await queryRunner.query(
      'ALTER TABLE provider_models DROP CONSTRAINT provider_models_model_type_check',
    );
    await queryRunner.query(
      "ALTER TABLE provider_models ADD CONSTRAINT provider_models_model_type_check CHECK (model_type IN ('language', 'embedding', 'rerank', 'speech', 'asr', 'image', 'ocr'))",
    );
  }
}
