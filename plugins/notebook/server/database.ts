import {
  EntitySchema,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';
import type { PluginDatabase } from '@app/plugin-sdk/server';

export interface Note {
  id: string;
  userId: string;
  title: string;
  slug: string;
  content: string;
  createdAt: Date;
}
export const NoteEntity = new EntitySchema<Note>({
  name: 'PluginNotebookNote',
  tableName: 'plugin_notebook_notes',
  columns: {
    id: { type: 'uuid', primary: true },
    userId: { name: 'user_id', type: 'text' },
    title: { type: 'text' },
    slug: { type: 'text' },
    content: { type: 'text' },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
  },
});
class CreateNotebookNotes1780000015000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE plugin_notebook_notes (
      id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL, slug text NOT NULL, content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(
      'CREATE INDEX plugin_notebook_notes_user_created ON plugin_notebook_notes (user_id, created_at DESC)',
    );
  }
  async down(runner: QueryRunner) {
    await runner.query('DROP TABLE plugin_notebook_notes');
  }
}
export default {
  entities: [NoteEntity],
  migrations: [CreateNotebookNotes1780000015000],
} satisfies PluginDatabase;
