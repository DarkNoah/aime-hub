import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatIdleWake1780000029000 implements MigrationInterface {
  name = 'GroupChatIdleWake1780000029000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_agents
      ADD COLUMN idle_wake_hours double precision CHECK (idle_wake_hours IS NULL OR (idle_wake_hours > 0 AND idle_wake_hours <= 8760 AND role='bot')),
      ADD COLUMN idle_since timestamptz DEFAULT now()`);
    await runner.query(
      `UPDATE group_chat_agents SET idle_since=NULL WHERE status='running'`,
    );
    await runner.query(`ALTER TABLE group_chat_events DROP CONSTRAINT group_chat_events_kind_check;
      ALTER TABLE group_chat_events ADD CONSTRAINT group_chat_events_kind_check CHECK (kind IN ('messages','task','plan','idle'))`);
    await runner.query(`CREATE INDEX group_chat_agents_idle ON group_chat_agents(idle_since) WHERE role='bot' AND idle_wake_hours IS NOT NULL AND enabled AND NOT deleting AND status IN ('idle','failed');
      CREATE INDEX group_chat_events_agent_pending ON group_chat_events(agent_id,kind) WHERE status='pending'`);
    await runner.query(
      `CREATE INDEX group_chat_reactions_filter ON group_chat_reactions(room_id,emoji,message_id)`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DELETE FROM group_chat_events WHERE kind='idle';
      ALTER TABLE group_chat_events DROP CONSTRAINT group_chat_events_kind_check;
      ALTER TABLE group_chat_events ADD CONSTRAINT group_chat_events_kind_check CHECK (kind IN ('messages','task','plan'));
      DROP INDEX group_chat_agents_idle;
      DROP INDEX group_chat_events_agent_pending;
      DROP INDEX group_chat_reactions_filter;
      ALTER TABLE group_chat_agents DROP COLUMN idle_wake_hours, DROP COLUMN idle_since`);
  }
}
