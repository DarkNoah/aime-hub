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

export function getWorkspaceFilePath(href?: string): string | undefined {
  if (!href || hasControlCharacters(href)) return undefined;

  if (href.toLowerCase().startsWith(WORKSPACE_FILE_LINK_PREFIX)) {
    try {
      return normalizeWorkspacePath(
        decodeURIComponent(href.slice(WORKSPACE_FILE_LINK_PREFIX.length)),
      );
    } catch {
      return undefined;
    }
  }

  if (
    URI_SCHEME.test(href) ||
    href.startsWith('//') ||
    href.startsWith('\\') ||
    href.startsWith('#') ||
    href.startsWith('?')
  ) {
    return undefined;
  }

  try {
    return normalizeWorkspacePath(decodeURIComponent(href));
  } catch {
    return undefined;
  }
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

export function toWorkspaceFileLink(path: string, directory = false): string {
  return `${WORKSPACE_FILE_LINK_PREFIX}${encodeURIComponent(`${path}${directory ? '/' : ''}`)}`;
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
          const path = getWorkspaceFilePath(href);
          if (path && node.properties) {
            node.properties.href = toWorkspaceFileLink(
              path,
              isWorkspaceDirectoryLink(href),
            );
          }
        }
      }

      node.children?.forEach(visit);
    };

    visit(tree);
  };
}
