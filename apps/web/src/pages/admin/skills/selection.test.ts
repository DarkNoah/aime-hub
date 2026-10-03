import assert from 'node:assert/strict';
import test from 'node:test';
import type { RepositorySkill } from '@aime/shared/skills';
import { selectionState, skillFolders, toggleSkills } from './selection';

const skill = (
  path: string,
  group: string,
  extra: Partial<RepositorySkill> = {},
): RepositorySkill => ({
  path,
  group,
  name: path,
  destination: path,
  description: '',
  installed: false,
  valid: true,
  errors: [],
  fileCount: 1,
  bytes: 1,
  skippedFiles: 0,
  ...extra,
});

test('folder selection includes nested descendants, excludes installed/invalid, and retains unrelated selections', () => {
  const all = [
    skill('root', ''),
    skill('a', 'skills'),
    skill('b', 'skills/tools'),
    skill('c', 'skills/tools', { installed: true }),
    skill('d', 'skills', { valid: false }),
  ];
  const root = skillFolders(all);
  assert.deepEqual(
    root.skills.map((item) => item.path),
    ['root'],
  );
  assert.equal(root.folders[0].folders[0].label, 'tools');
  assert.equal(root.folders[0].descendants.length, 4);
  const selected = toggleSkills(
    new Set(['root']),
    root.folders[0].descendants,
    true,
  );
  assert.deepEqual([...selected], ['root', 'a', 'b']);
  assert.equal(selectionState(all, selected), true);
  const partial = toggleSkills(selected, [all[2]], false);
  assert.equal(
    selectionState(root.folders[0].descendants, partial),
    'indeterminate',
  );
  assert.deepEqual(
    [...toggleSkills(partial, root.folders[0].descendants, false)],
    ['root'],
  );
  assert.equal(selectionState([all[3], all[4]], selected), false);
});
