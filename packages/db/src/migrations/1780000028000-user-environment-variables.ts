import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UserEnvironmentVariables1780000028000 implements MigrationInterface {
  name = 'UserEnvironmentVariables1780000028000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE environment_variables
      ADD COLUMN user_id text,
      DROP CONSTRAINT environment_variables_name_key`);
    await queryRunner.query(`CREATE UNIQUE INDEX environment_variables_global_name_key
      ON environment_variables(name) WHERE user_id IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX environment_variables_user_name_key
      ON environment_variables(user_id, name) WHERE user_id IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // The previous schema supports global variables only.
    await queryRunner.query(
      'DELETE FROM environment_variables WHERE user_id IS NOT NULL',
    );
    await queryRunner.query('DROP INDEX environment_variables_user_name_key');
    await queryRunner.query('DROP INDEX environment_variables_global_name_key');
    await queryRunner.query(`ALTER TABLE environment_variables
      DROP COLUMN user_id,
      ADD CONSTRAINT environment_variables_name_key UNIQUE (name)`);
  }
}
