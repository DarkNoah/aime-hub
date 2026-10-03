import type { FileEntry } from '@aime/shared/files';

export const rootEntry: FileEntry = { path: '', name: '', kind: 'directory' };
export type FileTab = { path: string; line?: number };
export const withinPath = (path: string, parent: string) =>
  path === parent || path.startsWith(`${parent}/`);
export const parentPath = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export function renameTabs(tabs: FileTab[], from: string, to: string) {
  return tabs.map((tab) =>
    withinPath(tab.path, from)
      ? { ...tab, path: to + tab.path.slice(from.length) }
      : tab,
  );
}
export function validName(name: string) {
  return (
    !!name.trim() &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/]/.test(name) &&
    ![...name].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
