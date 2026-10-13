export type WorkspaceLayout = {
  mode: 'docked' | 'floating' | 'collapsed';
  inspectorSize: number;
};

const STORAGE_KEY = 'chat-workspace-layout:v1';
const DEFAULT_LAYOUT: WorkspaceLayout = { mode: 'docked', inspectorSize: 38 };

export function readWorkspaceLayout(): WorkspaceLayout {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? 'null',
    );
    if (
      value &&
      typeof value === 'object' &&
      'mode' in value &&
      (value.mode === 'docked' ||
        value.mode === 'floating' ||
        value.mode === 'collapsed') &&
      'inspectorSize' in value &&
      typeof value.inspectorSize === 'number' &&
      Number.isFinite(value.inspectorSize) &&
      value.inspectorSize > 0 &&
      value.inspectorSize < 100
    ) {
      return { mode: value.mode, inspectorSize: value.inspectorSize };
    }
  } catch {
    // A missing or unavailable preference must not prevent opening the workspace.
  }
  return DEFAULT_LAYOUT;
}

export function saveWorkspaceLayout(layout: WorkspaceLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Resizing remains available when storage is blocked or full.
  }
}
