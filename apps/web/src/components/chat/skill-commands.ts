import type { ChatSkill } from '@aime/shared/threads';
import type { SlashCommandGroup, SlashCommandItem } from './slash-command.js';

export function skillCommandGroup(
  skills: ChatSkill[],
  label: string,
): SlashCommandGroup {
  const sections = new Map<string, SlashCommandItem[]>();
  for (const skill of skills) {
    const group = skill.group || '';
    const items = sections.get(group) ?? [];
    items.push({
      id: `skill:${skill.name}`,
      name: skill.name,
      description: skill.description,
    });
    sections.set(group, items);
  }
  return {
    id: 'skills',
    label,
    sections: [...sections]
      .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
      .map(([group, items]) => ({
        id: group,
        label: group || undefined,
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
      })),
  };
}
