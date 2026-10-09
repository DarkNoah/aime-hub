import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEnvironmentVariables1780000004000 implements MigrationInterface {
  name = 'CreateEnvironmentVariables1780000004000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE environment_variables (
        id uuid CONSTRAINT environment_variables_pkey PRIMARY KEY,
        name varchar(128) NOT NULL,
        value text NOT NULL,
        description text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT environment_variables_name_key UNIQUE (name),
        CONSTRAINT environment_variables_name_check CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]*$')
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE environment_variables');
  }
}
