import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProviderOcrModel1780000020000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE provider_models DROP CONSTRAINT provider_models_model_type_check`,
    );
    await queryRunner.query(
      `ALTER TABLE provider_models ADD CONSTRAINT provider_models_model_type_check CHECK (model_type IN ('language', 'embedding', 'rerank', 'speech', 'image', 'ocr'))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse rollback while OCR rows exist instead of silently changing their meaning.
    await queryRunner.query(
      `ALTER TABLE provider_models DROP CONSTRAINT provider_models_model_type_check`,
    );
    await queryRunner.query(
      `ALTER TABLE provider_models ADD CONSTRAINT provider_models_model_type_check CHECK (model_type IN ('language', 'embedding', 'rerank', 'speech', 'image'))`,
    );
  }
}
