import type { FileSave } from '@aime/shared/files';
import type { InstalledSkill } from '@aime/shared/skills';
import { getSkillApi, type SkillScope } from './api';

export function createSkillFileClient(
  scope: SkillScope,
  skill: string,
  onSaved: (skill: InstalledSkill) => void,
) {
  const api = getSkillApi(scope).files;
  return {
    list: (path: string, signal?: AbortSignal) =>
      api.list({ query: { skill, path } }, { signal }),
    preview: (path: string, signal?: AbortSignal) =>
      api.preview({ query: { skill, path } }, { signal }),
    save: async (body: FileSave) => {
      const result = await api.save({ query: { skill }, body });
      onSaved(result.skill);
      return result.file;
    },
    raw: (path: string, download = false) =>
      `/api/${scope === 'global' ? 'admin/' : ''}skills/files/raw?${new URLSearchParams({ skill, path, ...(download ? { download: '1' } : {}) })}`,
  };
}

export type SkillFileClient = ReturnType<typeof createSkillFileClient>;
