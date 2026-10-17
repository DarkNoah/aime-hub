export type SlashCommandItem = {
  id: string;
  name: string;
  description: string;
  action?: 'goal' | 'compact' | 'draw' | 'voices';
};

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
            [item.name, item.description, section.label ?? ''].some((text) =>
              text.toLocaleLowerCase().includes(search),
            ),
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
