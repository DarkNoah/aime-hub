import type { FileEntry, FileSave } from '@aime/shared/files';
import type { InstalledSkill } from '@aime/shared/skills';
import { parentPath } from '@/components/file-manager/state';
import { apiErrorCode } from '@/lib/rpc';
import { getSkillApi, type SkillScope } from './api';

export function createSkillFileClient(
  scope: SkillScope,
  skill: string,
  onSaved: (skill: InstalledSkill) => void,
) {
  const api = getSkillApi(scope).files;
  const list = (path: string, signal?: AbortSignal) =>
    api.list({ query: { skill, path } }, { signal });
  const preview = (path: string, signal?: AbortSignal) =>
    api.preview({ query: { skill, path } }, { signal });
  return {
    list,
    preview,
    async resolveKind(
      path: string,
      signal: AbortSignal,
    ): Promise<FileEntry['kind'] | undefined> {
      if (!path) return 'directory';
      const listing = await list(parentPath(path), signal);
      const entry = listing.entries.find((entry) => entry.path === path);
      if (entry || !listing.truncated) return entry?.kind;
      // A valid target may be outside the directory listing's 2,000-entry limit.
      try {
        await preview(path, signal);
        return 'file';
      } catch (error) {
        if (apiErrorCode(error) === 'FILE_NOT_FILE') return 'directory';
        throw error;
      }
    },
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
