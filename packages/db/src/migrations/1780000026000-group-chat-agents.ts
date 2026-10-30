import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatAgents1780000026000 implements MigrationInterface {
  name = 'GroupChatAgents1780000026000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE group_chats ADD COLUMN deleting boolean NOT NULL DEFAULT false`,
    );
    await runner.query(`ALTER TABLE group_chat_messages
      ADD COLUMN revision bigserial NOT NULL,
      ADD COLUMN sender_kind text NOT NULL DEFAULT 'user' CHECK (sender_kind IN ('user','agent')),
      ADD COLUMN reply_to_id text,
      ADD COLUMN files jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN ui jsonb,
      ADD COLUMN ui_response jsonb,
      ADD COLUMN target_agent_id text,
      ADD COLUMN search_terms jsonb NOT NULL DEFAULT '{}',
      ADD COLUMN token_count integer NOT NULL DEFAULT 0`);
    await runner.query(`CREATE INDEX group_chat_messages_changes ON group_chat_messages(room_id,revision);
      CREATE INDEX group_chat_messages_search ON group_chat_messages USING gin(search_terms)`);
    await runner.query(`CREATE TABLE group_chat_agents (
      id text PRIMARY KEY,
      room_id text NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      thread_id text NOT NULL UNIQUE,
      name text NOT NULL,
      role text NOT NULL CHECK (role IN ('bot','worker')),
      settings jsonb NOT NULL DEFAULT '{"agentId":null,"model":null,"reasoningEffort":"auto"}',
      enabled boolean NOT NULL DEFAULT true,
      deleting boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','failed')),
      error text,
      last_read_sequence bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE UNIQUE INDEX group_chat_agents_bot ON group_chat_agents(room_id) WHERE role = 'bot';
      CREATE INDEX group_chat_agents_room ON group_chat_agents(room_id)`);
    await runner.query(`CREATE TABLE group_chat_reactions (
      room_id text NOT NULL,
      message_id text NOT NULL,
      member_id text NOT NULL,
      emoji text NOT NULL,
      PRIMARY KEY(room_id,message_id,member_id,emoji),
      FOREIGN KEY(room_id,message_id) REFERENCES group_chat_messages(room_id,id) ON DELETE CASCADE
    )`);
    await runner.query(`CREATE TABLE group_chat_events (
      id text PRIMARY KEY,
      version text NOT NULL,
      room_id text NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      agent_id text NOT NULL REFERENCES group_chat_agents(id) ON DELETE CASCADE,
      actor_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('messages','task','plan')),
      text text NOT NULL,
      due_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','cancelled')),
      error text,
      lease_until timestamptz,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )`);
    await runner.query(`CREATE INDEX group_chat_events_due ON group_chat_events(due_at) WHERE status = 'pending';
      CREATE INDEX group_chat_events_room ON group_chat_events(room_id,created_at DESC)`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chats DROP COLUMN deleting`);
    await runner.query(
      'DROP TABLE group_chat_events; DROP TABLE group_chat_reactions; DROP TABLE group_chat_agents',
    );
    await runner.query(`ALTER TABLE group_chat_messages DROP COLUMN revision,DROP COLUMN sender_kind,
      DROP COLUMN reply_to_id,DROP COLUMN files,DROP COLUMN ui,DROP COLUMN ui_response,
      DROP COLUMN target_agent_id,DROP COLUMN search_terms,DROP COLUMN token_count`);
  }
}
