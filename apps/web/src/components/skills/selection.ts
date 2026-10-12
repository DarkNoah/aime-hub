import type { RepositorySkill } from '@aime/shared/skills';

export type SkillFolder = {
  path: string;
  label: string;
  folders: SkillFolder[];
  skills: RepositorySkill[];
  descendants: RepositorySkill[];
};

export function skillFolders(skills: RepositorySkill[]): SkillFolder {
  const root: SkillFolder = {
    path: '',
    label: '',
    folders: [],
    skills: [],
    descendants: [],
  };
  for (const skill of skills) {
    let folder = root;
    folder.descendants.push(skill);
    for (const segment of skill.group.split('/').filter(Boolean)) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      let child = folder.folders.find((item) => item.path === path);
      if (!child) {
        child = {
          path,
          label: segment,
          folders: [],
          skills: [],
          descendants: [],
        };
        folder.folders.push(child);
      }
      child.descendants.push(skill);
      folder = child;
    }
    folder.skills.push(skill);
  }
  return root;
}

export function selectableSkills(skills: RepositorySkill[]) {
  return skills.filter((skill) => skill.valid && !skill.installed);
}

export function selectionState(
  skills: RepositorySkill[],
  selected: Set<string>,
): boolean | 'indeterminate' {
  const available = selectableSkills(skills);
  const count = available.filter((skill) => selected.has(skill.path)).length;
  return count === 0
    ? false
    : count === available.length
      ? true
      : 'indeterminate';
}

export function toggleSkills(
  selected: Set<string>,
  skills: RepositorySkill[],
  checked: boolean,
) {
  const next = new Set(selected);
  for (const skill of selectableSkills(skills)) {
    if (checked) next.add(skill.path);
    else next.delete(skill.path);
  }
  return next;
}
