import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProjectEnvironmentVariables1780000037000 implements MigrationInterface {
  name = 'ProjectEnvironmentVariables1780000037000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE environment_variables
      ADD COLUMN project_id text,
      ADD CONSTRAINT environment_variables_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      ADD CONSTRAINT environment_variables_scope_check CHECK (user_id IS NULL OR project_id IS NULL)`);
    await runner.query('DROP INDEX environment_variables_global_name_key');
    await runner.query('DROP INDEX environment_variables_user_name_key');
    await runner.query(`CREATE UNIQUE INDEX environment_variables_global_name_key
      ON environment_variables(name) WHERE user_id IS NULL AND project_id IS NULL`);
    await runner.query(`CREATE UNIQUE INDEX environment_variables_user_name_key
      ON environment_variables(user_id, name) WHERE user_id IS NOT NULL AND project_id IS NULL`);
    await runner.query(`CREATE UNIQUE INDEX environment_variables_project_name_key
      ON environment_variables(project_id, name) WHERE project_id IS NOT NULL`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // The previous schema cannot represent project variables.
    await runner.query(
      'DELETE FROM environment_variables WHERE project_id IS NOT NULL',
    );
    await runner.query('DROP INDEX environment_variables_project_name_key');
    await runner.query('DROP INDEX environment_variables_global_name_key');
    await runner.query('DROP INDEX environment_variables_user_name_key');
    await runner.query(`ALTER TABLE environment_variables
      DROP CONSTRAINT environment_variables_scope_check,
      DROP COLUMN project_id`);
    await runner.query(`CREATE UNIQUE INDEX environment_variables_global_name_key
      ON environment_variables(name) WHERE user_id IS NULL`);
    await runner.query(`CREATE UNIQUE INDEX environment_variables_user_name_key
      ON environment_variables(user_id, name) WHERE user_id IS NOT NULL`);
  }
}
