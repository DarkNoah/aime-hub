const WORKSPACE_FILE_LINK_PREFIX = 'streamdown:workspace-file/';
const hasControlCharacters = (value: string) =>
  [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function normalizeWorkspacePath(path: string): string | undefined {
  if (
    !path ||
    hasControlCharacters(path) ||
    path.startsWith('//') ||
    path.startsWith('\\') ||
    path.includes('?') ||
    path.includes('#')
  ) {
    return undefined;
  }

  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.');
  // Authorization and absolute-path mapping happen on the server when opened.
  // Preserve the personal shared prefix through Streamdown's URL rewriting.
  let prefix = path.startsWith('/') ? '/' : '';
  if (!prefix && parts[0] === '..' && parts[1] === 'shared') {
    prefix = '../shared';
    parts.splice(0, 2);
  }
  const segments: string[] = [];
  for (const segment of parts) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    if (segment.includes(':')) return undefined;
    segments.push(segment);
  }

  if (prefix === '../shared')
    return `${prefix}${segments.length ? '/' + segments.join('/') : ''}`;
  return prefix || segments.length
    ? `${prefix}${segments.join('/')}`
    : undefined;
}

export type WorkspaceFileTarget = { path: string; line?: number };

export function getWorkspaceFileTarget(
  href?: string,
): WorkspaceFileTarget | undefined {
  if (!href || hasControlCharacters(href)) return undefined;

  if (href.toLowerCase().startsWith(WORKSPACE_FILE_LINK_PREFIX)) {
    href = href.slice(WORKSPACE_FILE_LINK_PREFIX.length);
  } else if (
    URI_SCHEME.test(href) ||
    href.startsWith('//') ||
    href.startsWith('\\') ||
    href.startsWith('#') ||
    href.startsWith('?')
  ) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(href);
    const suffix = /:(\d+)$/.exec(decoded);
    const line = suffix ? Number(suffix[1]) : undefined;
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1))
      return undefined;
    const rawPath = suffix ? decoded.slice(0, suffix.index) : decoded;
    if (line !== undefined && /[/\\]$/.test(rawPath)) return undefined;
    const path = normalizeWorkspacePath(rawPath);
    return path ? { path, ...(line !== undefined ? { line } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

export function getWorkspaceFilePath(href?: string): string | undefined {
  return getWorkspaceFileTarget(href)?.path;
}

export function isWorkspaceDirectoryLink(href?: string): boolean {
  if (!href) return false;

  try {
    const path = href.toLowerCase().startsWith(WORKSPACE_FILE_LINK_PREFIX)
      ? href.slice(WORKSPACE_FILE_LINK_PREFIX.length)
      : href;
    return /[/\\]$/.test(decodeURIComponent(path));
  } catch {
    return false;
  }
}

export function toWorkspaceFileLink(
  path: string,
  directory = false,
  line?: number,
): string {
  return `${WORKSPACE_FILE_LINK_PREFIX}${encodeURIComponent(`${path}${directory ? '/' : line !== undefined ? `:${line}` : ''}`)}`;
}

type HastNode = {
  children?: HastNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
};

export function rehypeWorkspaceFileLinks() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (node.type === 'element' && node.tagName === 'a') {
        const href = node.properties?.href;
        if (typeof href === 'string') {
          const target = getWorkspaceFileTarget(href);
          if (target && node.properties) {
            node.properties.href = toWorkspaceFileLink(
              target.path,
              isWorkspaceDirectoryLink(href),
              target.line,
            );
          }
        }
      }

      if (node.type === 'element' && node.tagName === 'img') {
        const src = node.properties?.src;
        if (typeof src === 'string') {
          const target = getWorkspaceFileTarget(src);
          if (
            target &&
            target.line === undefined &&
            !isWorkspaceDirectoryLink(src) &&
            node.properties
          ) {
            // Preserve workspace paths before Streamdown hardens image URLs.
            // A dedicated tag keeps its built-in renderer for remote images.
            node.tagName = 'workspace-image';
            node.properties.src = toWorkspaceFileLink(target.path);
          }
        }
      }

      node.children?.forEach(visit);
    };

    visit(tree);
  };
}
