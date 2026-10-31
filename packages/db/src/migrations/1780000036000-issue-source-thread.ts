import type { MigrationInterface, QueryRunner } from 'typeorm';

export class IssueSourceThread1780000036000 implements MigrationInterface {
  name = 'IssueSourceThread1780000036000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE issues ADD COLUMN source_thread_id text
      REFERENCES group_chat_agents(thread_id) ON DELETE SET NULL`);
    // Older tool results contain the exact task ID and thread ID. Recover only
    // successful creations from a room thread in the same scope, never by title.
    const [storage] = await runner.query(
      `SELECT to_regclass('mastra.mastra_messages') AS messages`,
    );
    if (!storage.messages) return;
    const issues: {
      id: number;
      thread_id: string;
      project_id: string | null;
    }[] = await runner.query('SELECT id,thread_id,project_id FROM issues');
    if (!issues.length) return;
    const targets = new Map(issues.map((issue) => [issue.id, issue]));
    const matches = new Map<number, Set<string>>();
    let cursor = '';
    while (true) {
      const rows: {
        id: string;
        thread_id: string;
        project_id: string | null;
        content: string;
      }[] = await runner.query(
        `SELECT m.id,m.thread_id,r.project_id,m.content
         FROM mastra.mastra_messages m
         JOIN group_chat_agents a ON a.thread_id=m.thread_id AND NOT a.deleting
         JOIN group_chats r ON r.id=a.room_id AND NOT r.deleting
         WHERE m.id>$1 AND m.role='assistant' AND m.content LIKE '%issue%'
           AND EXISTS (SELECT 1 FROM issues i WHERE i.project_id IS NOT DISTINCT FROM r.project_id)
         ORDER BY m.id LIMIT 100`,
        [cursor],
      );
      for (const row of rows) {
        let content;
        try {
          content = JSON.parse(row.content);
        } catch {
          continue;
        }
        if (!Array.isArray(content?.parts)) continue;
        for (const part of content.parts) {
          const call = part?.toolInvocation;
          const result = call?.result?.issue;
          if (
            call?.toolName !== 'issue' ||
            typeof call.args?.command !== 'string' ||
            !/^\s*(?:issue\s+)?create(?:\s|$)/.test(call.args.command) ||
            !result
          )
            continue;
          const issue = targets.get(result.id);
          if (
            !issue ||
            issue.thread_id !== result.threadId ||
            issue.project_id !== row.project_id
          )
            continue;
          const sources = matches.get(issue.id) ?? new Set<string>();
          sources.add(row.thread_id);
          matches.set(issue.id, sources);
        }
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.id;
    }
    for (const [id, sources] of matches) {
      if (sources.size !== 1) continue;
      await runner.query(
        'UPDATE issues SET source_thread_id=$2 WHERE id=$1 AND source_thread_id IS NULL',
        [id, [...sources][0]],
      );
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE issues DROP COLUMN source_thread_id');
  }
}
