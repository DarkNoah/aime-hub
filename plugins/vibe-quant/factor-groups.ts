import type { FactorGroup } from './factor-types.js';

export const UNGROUPED = '00000000-0000-4000-8000-000000000001';
export const FACTOR_GROUPS: readonly FactorGroup[] = [
  { id: UNGROUPED, name: '未分类', parent_id: null, builtin: true },
  {
    id: '00000000-0000-4000-8000-000000000101',
    name: 'WorldQuant Alpha101',
    parent_id: null,
    builtin: true,
  },
  {
    id: '00000000-0000-4000-8000-000000000191',
    name: '国泰君安',
    parent_id: null,
    builtin: true,
  },
  {
    id: '00000000-0000-4000-8000-000000000158',
    name: 'Qlib Alpha158',
    parent_id: null,
    builtin: true,
  },
  {
    id: '00000000-0000-4000-8000-000000000360',
    name: 'Qlib Alpha360',
    parent_id: null,
    builtin: true,
  },
];

export function groupDescendants(
  groups: readonly FactorGroup[],
  id: string,
): Set<string> {
  const ids = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const group of groups) {
      if (group.parent_id && ids.has(group.parent_id) && !ids.has(group.id)) {
        ids.add(group.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function groupOptions(
  groups: readonly FactorGroup[],
): { id: string; label: string }[] {
  const result: { id: string; label: string }[] = [];
  const visited = new Set<string>();
  function append(parent: string | null, prefix: string) {
    for (const group of groups.filter((g) => g.parent_id === parent)) {
      if (visited.has(group.id)) continue;
      visited.add(group.id);
      const label = prefix + group.name;
      result.push({ id: group.id, label });
      append(group.id, label + ' / ');
    }
  }
  append(null, '');
  return result;
}
