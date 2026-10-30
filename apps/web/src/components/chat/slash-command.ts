export type SlashCommandItem = {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  disabled?: boolean;
  current?: boolean;
} & (
  | { action?: 'goal' | 'compact' | 'draw' | 'voices' }
  | { action: 'agent'; agentId: string | null }
  | { action: 'mention'; mention: string }
);

export type SlashCommandSection = {
  id: string;
  label?: string;
  items: SlashCommandItem[];
};

export type SlashCommandGroup = {
  id: string;
  label?: string;
  sections: SlashCommandSection[];
};

export function getSlashCommand(text: string, start: number, end = start) {
  if (start !== end || start < 1 || !text.startsWith('/')) return null;
  const token = text.match(/^\/[^\s]*/)?.[0];
  if (!token || token.slice(1).includes('/') || start > token.length)
    return null;
  return { query: text.slice(1, start), end: token.length };
}

/** Mentions can occur mid-message; two trailing spaces finish a chosen mention. */
export function getMentionCommand(text: string, start: number, end = start) {
  if (start !== end) return null;
  const before = text.slice(0, start);
  const match = /(?:^|[\s([{"'“‘，。！？、：；])@([^@\n]*)$/.exec(before);
  if (!match || match[1].includes('  ')) return null;
  return { query: match[1], start: before.lastIndexOf('@'), end: start };
}

export function insertMention(
  text: string,
  start: number,
  end: number,
  mention: string,
) {
  const prefix = text.slice(0, start);
  const separator =
    prefix && !/[\s([{"'“‘，。！？、：；]$/.test(prefix) ? ' ' : '';
  const inserted = `${separator}${mention}  `;
  return {
    text: prefix + inserted + text.slice(end),
    caret: prefix.length + inserted.length,
  };
}

export function filterCommandGroups(
  groups: SlashCommandGroup[],
  query: string,
) {
  const search = query.toLocaleLowerCase();
  return groups
    .map((group) => ({
      ...group,
      sections: group.sections
        .map((section) => ({
          ...section,
          items: section.items.filter((item) =>
            [
              item.name,
              item.description,
              section.label ?? '',
              group.label ?? '',
              ...(item.keywords ?? []),
            ].some((text) => text.toLocaleLowerCase().includes(search)),
          ),
        }))
        .filter((section) => section.items.length > 0),
    }))
    .filter((group) => group.sections.length > 0);
}

export function completeSlashCommand(text: string, end: number, name: string) {
  const suffix = text.slice(end);
  const command = `/${name}`;
  const separator = suffix.startsWith(' ') ? '' : ' ';
  return {
    text: command + separator + suffix,
    caret: command.length + 1,
  };
}

/** Action commands consume only the command token; skills remain prompt text. */
export function applySlashCommand(
  text: string,
  end: number,
  item: SlashCommandItem,
) {
  return item.action
    ? { text: text.slice(end).replace(/^\s+/, ''), caret: 0 }
    : completeSlashCommand(text, end, item.name);
}

/** Built-in mode commands are consumed locally, never sent as prompt text. */
export function consumeGoalCommand(text: string): string | null {
  return /^\/goal(?:\s|$)/i.test(text)
    ? text.replace(/^\/goal(?:\s+|$)/i, '')
    : null;
}

export function consumeCompactCommand(text: string): string | null {
  return /^\/compact(?:\s|$)/i.test(text)
    ? text.replace(/^\/compact(?:\s+|$)/i, '')
    : null;
}

export function consumeDrawCommand(text: string): string | null {
  return /^\/draw(?:\s|$)/i.test(text)
    ? text.replace(/^\/draw(?:\s+|$)/i, '')
    : null;
}

export function consumeVoicesCommand(text: string): string | null {
  return /^\/voices(?:\s|$)/i.test(text)
    ? text.replace(/^\/voices(?:\s+|$)/i, '')
    : null;
}
