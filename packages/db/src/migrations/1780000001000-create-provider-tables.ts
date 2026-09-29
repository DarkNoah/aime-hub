import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProviderTables1780000001000 implements MigrationInterface {
  name = 'CreateProviderTables1780000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE providers (
        id text CONSTRAINT providers_pkey PRIMARY KEY,
        name text NOT NULL,
        type text NOT NULL,
        base_url text NOT NULL,
        api_key text,
        enabled boolean NOT NULL DEFAULT true,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      )
    `);

    await queryRunner.query(`
      CREATE TABLE provider_models (
        provider_id text NOT NULL,
        id text NOT NULL,
        name text NOT NULL,
        description text,
        display_name text,
        enabled boolean NOT NULL DEFAULT true,
        deprecated boolean DEFAULT NULL,
        pass_test boolean DEFAULT NULL,
        modalities_input text[] NOT NULL DEFAULT '{text}'::text[],
        modalities_output text[] NOT NULL DEFAULT '{text}'::text[],
        reasoning boolean NOT NULL DEFAULT false,
        tool_call boolean NOT NULL DEFAULT false,
        limit_context integer,
        limit_output integer,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        CONSTRAINT provider_models_pkey PRIMARY KEY (provider_id, id),
        CONSTRAINT provider_models_provider_id_fkey FOREIGN KEY (provider_id)
          REFERENCES providers (id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE settings (
        id text CONSTRAINT settings_pkey PRIMARY KEY,
        value jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE settings');
    await queryRunner.query('DROP TABLE provider_models');
    await queryRunner.query('DROP TABLE providers');
  }
}
