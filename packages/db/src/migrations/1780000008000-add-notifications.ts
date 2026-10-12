import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotifications1780000008000 implements MigrationInterface {
  name = 'AddNotifications1780000008000';
  async up(queryRunner: QueryRunner) {
    await queryRunner.query(`CREATE TABLE automation_notifications (
      id text PRIMARY KEY,
      sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      owner_id text NOT NULL,
      scope text NOT NULL CHECK (scope IN ('personal', 'project', 'system')),
      project_id text,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE TABLE web_push_subscriptions (
      endpoint text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      keys jsonb NOT NULL,
      locale text NOT NULL DEFAULT 'en',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(
      'CREATE INDEX web_push_subscriptions_user ON web_push_subscriptions (user_id)',
    );
  }
  async down(queryRunner: QueryRunner) {
    await queryRunner.query('DROP TABLE web_push_subscriptions');
    await queryRunner.query('DROP TABLE automation_notifications');
  }
}
