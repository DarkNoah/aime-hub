import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthTables1780000000000 implements MigrationInterface {
  name = 'CreateAuthTables1780000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id text CONSTRAINT users_pkey PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL,
        email_verified boolean NOT NULL DEFAULT false,
        image text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        username text,
        display_username text,
        role text NOT NULL DEFAULT 'user',
        banned boolean NOT NULL DEFAULT false,
        ban_reason text,
        ban_expires timestamptz,
        CONSTRAINT users_email_unique UNIQUE (email),
        CONSTRAINT users_username_unique UNIQUE (username)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE sessions (
        id text CONSTRAINT sessions_pkey PRIMARY KEY,
        token text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        ip_address text,
        user_agent text,
        user_id text NOT NULL,
        impersonated_by text,
        CONSTRAINT sessions_token_unique UNIQUE (token),
        CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id)
          REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE accounts (
        id text CONSTRAINT accounts_pkey PRIMARY KEY,
        account_id text NOT NULL,
        provider_id text NOT NULL,
        user_id text NOT NULL,
        access_token text,
        refresh_token text,
        id_token text,
        access_token_expires_at timestamptz,
        refresh_token_expires_at timestamptz,
        scope text,
        password text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        CONSTRAINT accounts_provider_id_account_id_unique UNIQUE (provider_id, account_id),
        CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id)
          REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE verifications (
        id text CONSTRAINT verifications_pkey PRIMARY KEY,
        identifier text NOT NULL,
        value text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      )
    `);

    await queryRunner.query(
      'CREATE INDEX sessions_user_id_idx ON sessions (user_id)',
    );
    await queryRunner.query(
      'CREATE INDEX accounts_user_id_idx ON accounts (user_id)',
    );
    await queryRunner.query(
      'CREATE INDEX verifications_identifier_idx ON verifications (identifier)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX verifications_identifier_idx');
    await queryRunner.query('DROP INDEX accounts_user_id_idx');
    await queryRunner.query('DROP INDEX sessions_user_id_idx');
    await queryRunner.query('DROP TABLE verifications');
    await queryRunner.query('DROP TABLE accounts');
    await queryRunner.query('DROP TABLE sessions');
    await queryRunner.query('DROP TABLE users');
  }
}
