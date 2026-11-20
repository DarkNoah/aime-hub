const WORKSPACE_FILE_LINK_PREFIX = 'streamdown:workspace-file/';
const hasControlCharacters = (value: string) =>
  [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function resolveSegments(parts: string[], segments: string[]) {
  for (const segment of parts) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return;
      segments.pop();
    } else {
      if (segment.includes(':')) return;
      segments.push(segment);
    }
  }
  return segments;
}

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
  const segments = resolveSegments(parts, []);
  if (!segments) return undefined;

  if (prefix === '../shared')
    return `${prefix}${segments.length ? '/' + segments.join('/') : ''}`;
  return prefix || segments.length
    ? `${prefix}${segments.join('/')}`
    : undefined;
}

export type WorkspaceFileTarget = { path: string; line?: number };

function splitFileLine(value: string): WorkspaceFileTarget | undefined {
  const suffix = /:(\d+)$/.exec(value);
  if (!suffix) return { path: value };
  const line = Number(suffix[1]);
  const path = value.slice(0, suffix.index);
  if (path && Number.isSafeInteger(line) && line >= 1 && !/[/\\]$/.test(path))
    return { path, line };
}

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
    const target = splitFileLine(decodeURIComponent(href));
    const path = target && normalizeWorkspacePath(target.path);
    return path ? { ...target, path } : undefined;
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

function visitMarkdownNodes(node: HastNode, visit: (node: HastNode) => void) {
  visit(node);
  node.children?.forEach((child) => visitMarkdownNodes(child, visit));
}

function isDocumentRelativeHref(href: unknown): href is string {
  return (
    typeof href === 'string' &&
    !!href &&
    !/^[/#?]/.test(href) &&
    !URI_SCHEME.test(href)
  );
}

// Normalize URL shortcuts before sanitization or workspace path resolution.
export function rehypeMarkdownLinkUrls(options?: { sandboxFiles?: boolean }) {
  return (tree: HastNode) =>
    visitMarkdownNodes(tree, ({ tagName, properties }) => {
      if (tagName === 'a' && typeof properties?.href === 'string') {
        if (
          /^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#]|$)/i.test(
            properties.href,
          )
        ) {
          properties.href = `http://${properties.href}`;
        } else if (options?.sandboxFiles) {
          properties.href = properties.href.replace(
            /^sandbox:\/(?![/\\])/i,
            './',
          );
        }
      }
    });
}

// Keep the original href until the preview can resolve it against its own file.
// Absolute URLs and fragment-only links still go through Streamdown's hardening.
export function rehypePreviewFileLinks() {
  return (tree: HastNode) =>
    visitMarkdownNodes(tree, (node) => {
      if (
        node.tagName === 'a' &&
        isDocumentRelativeHref(node.properties?.href)
      ) {
        node.tagName = 'preview-file-link';
      }
    });
}

export function resolvePreviewFileLink(
  sourcePath: string,
  href: string,
): (WorkspaceFileTarget & { kind: 'file' | 'directory' }) | undefined {
  if (!isDocumentRelativeHref(href)) return;
  let target: WorkspaceFileTarget | undefined;
  try {
    target = splitFileLine(decodeURIComponent(href.split(/[?#]/, 1)[0]));
  } catch {
    return;
  }
  if (
    !target ||
    /^[\\/]/.test(target.path) ||
    hasControlCharacters(target.path)
  )
    return;
  const parts = target.path.split(/[/\\]/);
  const segments = resolveSegments(parts, sourcePath.split('/').slice(0, -1));
  const directory = ['', '.', '..'].includes(parts.at(-1)!);
  if (!segments || (directory && target.line !== undefined)) return;
  return {
    ...target,
    path: segments.join('/'),
    kind: directory ? 'directory' : 'file',
  };
}

export function rehypeWorkspaceFileLinks() {
  return (tree: HastNode) =>
    visitMarkdownNodes(tree, (node) => {
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
    });
}
