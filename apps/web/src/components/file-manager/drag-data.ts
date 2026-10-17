import type { WorkspaceFileReference } from '@aime/shared/files';
import { workspaceReferencePath } from '@aime/shared/files';
export { workspaceReferencePath } from '@aime/shared/files';

export const WORKSPACE_FILE_DRAG_TYPE = 'application/x-workspace-file';

export function writeWorkspaceFileDrag(
  transfer: DataTransfer,
  workspaceId: string,
  reference: WorkspaceFileReference,
) {
  transfer.effectAllowed = 'copy';
  transfer.setData(
    WORKSPACE_FILE_DRAG_TYPE,
    JSON.stringify({ workspaceId, ...reference }),
  );
  transfer.setData('text/plain', workspaceReferencePath(reference));
}

export function readWorkspaceFileDrag(
  transfer: Pick<DataTransfer, 'getData'>,
  workspaceId: string,
): WorkspaceFileReference | null {
  try {
    const value = JSON.parse(transfer.getData(WORKSPACE_FILE_DRAG_TYPE));
    if (
      !value ||
      value.workspaceId !== workspaceId ||
      !['thread', 'shared'].includes(value.scope) ||
      !['file', 'directory'].includes(value.kind) ||
      typeof value.path !== 'string' ||
      !value.path ||
      value.path.length > 2048 ||
      value.path.includes('\\') ||
      Array.from(value.path as string).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      value.path
        .split('/')
        .some((part: string) => ['', '.', '..'].includes(part))
    )
      return null;
    return { scope: value.scope, kind: value.kind, path: value.path };
  } catch {
    return null;
  }
}
