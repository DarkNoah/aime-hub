import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatBotPrompt1780000045000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_agents ADD COLUMN additional_prompt text
      CHECK (additional_prompt IS NULL OR role='bot')`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE group_chat_agents DROP COLUMN additional_prompt',
    );
  }
}
