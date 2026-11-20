import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  migrateMountedProjectSkills,
  migrateSkillLayouts,
} from '../apps/server/src/modules/skills/layout-migration.js';
import {
  readSkillArchiveGroup,
  readSkillProject,
} from '../apps/server/src/modules/skills/project.js';
import {
  identity,
  applyLayoutStep,
} from '../apps/server/src/modules/skills/layout-journal.js';
import { readSkillSources } from '../apps/server/src/modules/skills/sources.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import { SkillOrigins } from '../apps/server/src/modules/skills/origins.js';
import { resolveSkillShareLink } from '../apps/server/src/modules/skills/share-links.js';

const projectId = 'abcdefghijklmnop';
const manifest = (name: string) =>
  `---\nname: ${name}\ndescription: Layout migration fixture\n---\n# ${name}\n`;
const sorted = (entries: ReadonlyMap<string, string>) =>
  [...entries].sort(([left], [right]) => left.localeCompare(right));

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'skill-layout-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.agents'));
  const global = join(root, '.agents/skills');
  const personal = join(root, 'users/alice/.agents/skills');
  const project = join(root, 'projects', projectId, '.agents/skills');
  const shared = join(root, '.agents/project-skills', projectId);
  const service = new SkillService(root);
  t.after(() => service.dispose());
  return { root, global, personal, project, shared, service };
}

async function file(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function legacyArchive(
  store: string,
  slug: string,
  names = ['alpha', 'beta'],
) {
  for (const name of names) {
    await file(join(store, '@local', slug, name, 'SKILL.md'), manifest(name));
    await file(
      join(store, '@local', slug, name, 'assets/reference.txt'),
      `${slug}/${name}: keep me`,
    );
  }
}

async function legacyProject(
  store: string,
  unit: string,
  name = 'entry',
  sourceUrl?: string,
) {
  const group = join(store, unit);
  const entries = [{ path: 'skills/entry/SKILL.md', name }];
  const sourceMarkers = {
    '.skill-project.json': '{"upstream":"project marker"}',
    '.skill-sources.json': '{"upstream":"source marker"}',
  };
  await file(join(group, 'project/skills/entry/SKILL.md'), manifest(name));
  await file(
    join(group, 'project/project/real.txt'),
    'This project directory belongs to the upstream repository.',
  );
  await file(
    join(group, 'project/pyproject.toml'),
    '[project]\nname = "fixture"\n',
  );
  await file(
    join(group, 'project/.skill-meta/upstream-config.json'),
    '{"resource":true}',
  );
  for (const [path, content] of Object.entries(sourceMarkers))
    await file(join(group, 'project', path), content);
  await file(
    join(group, '.skill-project.json'),
    JSON.stringify({ version: 1, root: 'project', entries }),
  );
  const sources = sourceUrl
    ? [
        {
          url: sourceUrl,
          ref: 'feature/skills',
          scope: '',
          installation: { mode: 'project', entries },
        },
      ]
    : [];
  if (sources.length)
    await file(
      join(group, '.skill-sources.json'),
      JSON.stringify({ version: 2, sources }),
    );
  return { group, entries, sourceMarkers, sources };
}

async function alias(store: string, personal: string, unit: string) {
  const link = join(store, unit);
  await mkdir(dirname(link), { recursive: true });
  await symlink(relative(dirname(link), join(personal, unit)), link, 'dir');
}

async function absent(path: string) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

test('ordinary archives and v1 repositories migrate in global, personal and project stores while preserving real project directories and upstream metadata', async (t) => {
  const f = await fixture(t);
  const stores = [f.global, f.personal, f.project];
  for (const store of stores) {
    await legacyArchive(store, 'library');
    await legacyProject(
      store,
      'owner/project',
      'entry',
      'https://github.com/owner/project',
    );
  }
  const callbacks: { map: Map<string, string>; id: string }[] = [];
  await migrateSkillLayouts(f.root, async (paths, id) => {
    callbacks.push({ map: new Map(paths), id });
  });
  assert.equal(callbacks.length, 1);
  assert.deepEqual(
    sorted(callbacks[0].map),
    sorted(
      new Map([
        ['@local/library/alpha', 'library/alpha'],
        ['@local/library/beta', 'library/beta'],
        ['owner/project/project/skills/entry', 'owner/project/skills/entry'],
      ]),
    ),
  );
  for (const store of stores) {
    await absent(join(store, '@local'));
    assert.equal(await readSkillArchiveGroup(join(store, 'library')), true);
    for (const name of ['alpha', 'beta']) {
      assert.equal(
        await readFile(join(store, 'library', name, 'SKILL.md'), 'utf8'),
        manifest(name),
      );
      assert.equal(
        await readFile(
          join(store, 'library', name, 'assets/reference.txt'),
          'utf8',
        ),
        `library/${name}: keep me`,
      );
    }
    const group = join(store, 'owner/project');
    assert.deepEqual(await readSkillProject(group), {
      version: 2,
      root: '.',
      entries: [{ path: 'skills/entry/SKILL.md', name: 'entry' }],
    });
    assert.equal(
      await readFile(join(group, 'project/real.txt'), 'utf8'),
      'This project directory belongs to the upstream repository.',
    );
    await absent(join(group, 'project/project'));
    assert.equal(
      await readFile(join(group, '.skill-project.json'), 'utf8'),
      '{"upstream":"project marker"}',
    );
    assert.equal(
      await readFile(join(group, '.skill-sources.json'), 'utf8'),
      '{"upstream":"source marker"}',
    );
    assert.equal(
      await readFile(join(group, '.skill-meta/upstream-config.json'), 'utf8'),
      '{"resource":true}',
    );
    assert.deepEqual(await readSkillSources(group), [
      {
        url: 'https://github.com/owner/project',
        ref: 'feature/skills',
        scope: '',
        installation: {
          mode: 'project',
          entries: [{ path: 'skills/entry/SKILL.md', name: 'entry' }],
        },
      },
    ]);
  }
  for (const catalog of [
    f.service,
    f.service.forUser('alice'),
    f.service.forProject(projectId),
  ])
    assert.deepEqual(
      (await catalog.list()).skills.map((skill) => skill.path).sort(),
      ['library/alpha', 'library/beta', 'owner/project/skills/entry'],
    );
  await migrateSkillLayouts(f.root, async () => {
    assert.fail('Completed migrations must not replay the callback.');
  });
});

test('ordinary skill and whole-project aliases migrate independently for global and project audiences and remain readable and independently revocable', async (t) => {
  const f = await fixture(t);
  await legacyArchive(f.personal, 'library');
  await legacyProject(f.personal, '@local/whole', 'shared-entry');
  for (const store of [f.global, f.shared]) {
    await alias(store, f.personal, '@local/library/alpha');
    await alias(store, f.personal, '@local/library/beta');
    await alias(store, f.personal, '@local/whole');
  }
  let paths = new Map<string, string>();
  await migrateSkillLayouts(f.root, async (mapping) => {
    paths = new Map(mapping);
  });
  assert.deepEqual(
    sorted(paths),
    sorted(
      new Map([
        ['@local/library/alpha', 'library/alpha'],
        ['@local/library/beta', 'library/beta'],
        ['@local/whole/project/skills/entry', 'whole/skills/entry'],
      ]),
    ),
  );
  for (const store of [f.global, f.shared]) {
    await absent(join(store, '@local'));
    assert.equal(await readSkillArchiveGroup(join(store, 'library')), true);
    for (const unit of ['library/alpha', 'library/beta', 'whole']) {
      const link = join(store, unit);
      assert.equal((await lstat(link)).isSymbolicLink(), true);
      assert.equal(
        resolve(dirname(link), await readlink(link)),
        join(f.personal, unit),
      );
      assert.equal(
        (await resolveSkillShareLink(f.root, store, unit))?.userId,
        'alice',
      );
    }
  }
  for (const catalog of [f.service, f.service.forProject(projectId)]) {
    assert.equal(
      (await catalog.read('library/alpha')).content,
      manifest('alpha'),
    );
    assert.equal(
      (await catalog.read('whole/skills/entry')).content,
      manifest('shared-entry'),
    );
  }
  await f.service.unsharePersonal('alice', 'library/alpha', {
    scope: 'global',
  });
  await absent(join(f.global, 'library/alpha'));
  assert.equal(
    (await f.service.read('library/beta')).content,
    manifest('beta'),
  );
  assert.equal(
    (await f.service.forProject(projectId).read('library/alpha')).content,
    manifest('alpha'),
  );
  assert.equal(
    (await f.service.forUser('alice').read('library/alpha')).content,
    manifest('alpha'),
  );
  await f.service.unsharePersonal('alice', 'whole/skills/entry', {
    scope: 'project',
    projectId,
  });
  await absent(join(f.shared, 'whole'));
  assert.equal(
    (await f.service.read('whole/skills/entry')).content,
    manifest('shared-entry'),
  );
  assert.equal(
    (await f.service.forUser('alice').read('whole/skills/entry')).content,
    manifest('shared-entry'),
  );
});

test('project files first exposed after mounting migrate independently of startup and global fixed-path updates', async (t) => {
  const f = await fixture(t);
  await absent(f.project);
  await migrateSkillLayouts(f.root, async () => {
    assert.fail('An empty startup requires no database path update.');
  });
  // The database stays on the host while the mount's device changes.
  await file(
    join(f.root, 'projects', projectId + '.db'),
    'database identity fixture',
  );
  // These packages become visible only after the project filesystem mounts.
  await legacyArchive(f.project, 'mounted-archive', ['mounted']);
  await legacyProject(
    f.project,
    'owner/project',
    'mounted-project',
    'https://github.com/owner/project',
  );
  // A new legacy global directory must not be affected by project-only migration.
  await legacyArchive(f.global, 'global-unmounted', ['global']);
  await migrateMountedProjectSkills(join(f.root, 'projects', projectId));
  assert.equal(
    await readSkillArchiveGroup(join(f.project, 'mounted-archive')),
    true,
  );
  assert.equal(
    await readFile(join(f.project, 'mounted-archive/mounted/SKILL.md'), 'utf8'),
    manifest('mounted'),
  );
  assert.equal(
    (await readSkillProject(join(f.project, 'owner/project')))?.root,
    '.',
  );
  assert.equal(
    await readFile(join(f.project, 'owner/project/project/real.txt'), 'utf8'),
    'This project directory belongs to the upstream repository.',
  );
  await absent(join(f.project, '@local'));
  assert.equal(
    await readFile(
      join(f.global, '@local/global-unmounted/global/SKILL.md'),
      'utf8',
    ),
    manifest('global'),
  );
  await absent(join(f.global, 'global-unmounted'));
  await absent(
    join(f.root, `.agents/.skill-layout-migration-${projectId}.json`),
  );
  await absent(
    join(f.root, `.agents/.skill-layout-progress-${projectId}.json`),
  );
  await migrateMountedProjectSkills(join(f.root, 'projects', projectId));
  assert.deepEqual(
    (await f.service.forProject(projectId).list()).skills
      .map((skill) => skill.path)
      .sort(),
    ['mounted-archive/mounted', 'owner/project/skills/entry'],
  );
});

test('a mounted move resumes with the same inode on a new mount device', async (t) => {
  const f = await fixture(t);
  const from = join('projects', projectId, '.agents/skills/old');
  const path = join('projects', projectId, '.agents/skills/new');
  await file(join(f.root, from, 'SKILL.md'), manifest('mounted'));
  const current = await lstat(join(f.root, from), { bigint: true });
  const previousMount = { dev: current.dev + 1n, ino: current.ino };
  const step = {
    op: 'move' as const,
    from,
    path,
    id: identity(previousMount, true),
  };
  await applyLayoutStep(f.root, step);
  await applyLayoutStep(f.root, step);
  assert.equal(
    await readFile(join(f.root, path, 'SKILL.md'), 'utf8'),
    manifest('mounted'),
  );
});

test('a failed global path callback resumes the same migration id and exact fixed-path mapping after filesystem publication', async (t) => {
  const f = await fixture(t);
  await legacyArchive(f.global, 'library', ['alpha']);
  await legacyProject(
    f.global,
    'owner/project',
    'entry',
    'https://github.com/owner/project',
  );
  const originals = [
    '@local/library/alpha',
    'owner/project/project/skills/entry',
    'builtin/skill-installer',
  ];
  let fixedPaths = [...originals];
  const applied = new Set<string>();
  const callbacks: { map: Map<string, string>; id: string }[] = [];
  const callback = async (paths: ReadonlyMap<string, string>, id: string) => {
    callbacks.push({ map: new Map(paths), id });
    if (!applied.has(id)) {
      fixedPaths = fixedPaths.map((path) => paths.get(path) ?? path);
      applied.add(id);
    }
    if (callbacks.length === 1)
      throw new Error('database callback interrupted');
  };
  await assert.rejects(
    migrateSkillLayouts(f.root, callback),
    /database callback interrupted/,
  );
  assert.equal(
    await readFile(join(f.global, 'library/alpha/SKILL.md'), 'utf8'),
    manifest('alpha'),
  );
  await absent(join(f.global, '@local'));
  assert.equal(
    (
      await lstat(join(f.root, '.agents/.skill-layout-migration.json'))
    ).isFile(),
    true,
  );
  assert.equal(
    (await lstat(join(f.root, '.agents/.skill-layout-progress.json'))).isFile(),
    true,
  );
  await migrateSkillLayouts(f.root, callback);
  assert.equal(callbacks.length, 2);
  assert.equal(callbacks[0].id, callbacks[1].id);
  assert.deepEqual(sorted(callbacks[0].map), sorted(callbacks[1].map));
  assert.equal(applied.size, 1);
  assert.deepEqual(fixedPaths, [
    'library/alpha',
    'owner/project/skills/entry',
    'builtin/skill-installer',
  ]);
  await absent(join(f.root, '.agents/.skill-layout-migration.json'));
  await absent(join(f.root, '.agents/.skill-layout-progress.json'));
  await migrateSkillLayouts(f.root, async () => {
    assert.fail('Finished migrations cannot replay fixed-path updates.');
  });
});

test('ordinary and whole-project destination conflicts preserve both sides while unrelated groups continue migrating', async (t) => {
  const f = await fixture(t);
  await legacyArchive(f.global, 'ordinary-collision', ['old']);
  await file(
    join(f.global, 'ordinary-collision/kept/SKILL.md'),
    manifest('kept'),
  );
  await legacyProject(f.global, '@local/whole-collision', 'old-project');
  await file(
    join(f.global, 'whole-collision/SKILL.md'),
    manifest('kept-project'),
  );
  await legacyArchive(f.global, 'safe-archive', ['safe']);
  await legacyProject(f.global, '@local/safe-project', 'safe-project');
  // A blocked namespace must also retain grants to the same personal namespace.
  await legacyArchive(f.personal, 'ordinary-collision', ['owned']);
  await alias(f.global, f.personal, '@local/ordinary-collision/owned');
  await alias(f.shared, f.personal, '@local/ordinary-collision/owned');
  let paths = new Map<string, string>();
  const conflicts = await migrateSkillLayouts(f.root, async (mapping) => {
    paths = new Map(mapping);
  });
  assert.equal(conflicts.length, 2);
  assert.ok(
    conflicts.some((message) => message.includes('ordinary-collision')),
  );
  assert.ok(conflicts.some((message) => message.includes('whole-collision')));
  for (const store of [f.global, f.shared]) {
    const link = join(store, '@local/ordinary-collision/owned');
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(
      resolve(dirname(link), await readlink(link)),
      join(f.personal, '@local/ordinary-collision/owned'),
    );
    assert.equal(
      await readFile(join(link, 'SKILL.md'), 'utf8'),
      manifest('owned'),
    );
  }
  await assert.rejects(
    f.service.sharePersonal('alice', '@local/ordinary-collision/owned', {
      scope: 'project',
      projectId: 'anotherprojectid',
    }),
    { code: 'SKILL_CONFLICT' },
  );
  await absent(join(f.root, '.agents/project-skills/anotherprojectid/@local'));
  await absent(join(f.personal, 'ordinary-collision'));
  assert.equal(
    await readFile(
      join(f.global, '@local/ordinary-collision/old/SKILL.md'),
      'utf8',
    ),
    manifest('old'),
  );
  assert.equal(
    await readFile(join(f.global, 'ordinary-collision/kept/SKILL.md'), 'utf8'),
    manifest('kept'),
  );
  assert.equal(
    await readFile(
      join(f.global, '@local/whole-collision/project/skills/entry/SKILL.md'),
      'utf8',
    ),
    manifest('old-project'),
  );
  assert.equal(
    await readFile(join(f.global, 'whole-collision/SKILL.md'), 'utf8'),
    manifest('kept-project'),
  );
  assert.equal(
    await readFile(join(f.global, 'safe-archive/safe/SKILL.md'), 'utf8'),
    manifest('safe'),
  );
  assert.equal(
    await readFile(
      join(f.global, 'safe-project/skills/entry/SKILL.md'),
      'utf8',
    ),
    manifest('safe-project'),
  );
  await absent(join(f.global, '@local/safe-archive'));
  await absent(join(f.global, '@local/safe-project'));
  assert.deepEqual(
    sorted(paths),
    sorted(
      new Map([
        ['@local/safe-archive/safe', 'safe-archive/safe'],
        [
          '@local/safe-project/project/skills/entry',
          'safe-project/skills/entry',
        ],
      ]),
    ),
  );
  await migrateSkillLayouts(f.root, async () => {
    assert.fail('Only unresolved conflicts remain.');
  });
  assert.equal(
    await readFile(
      join(f.global, '@local/ordinary-collision/old/SKILL.md'),
      'utf8',
    ),
    manifest('old'),
  );
});

test('move-to-share origin records and proof markers follow migrated archive units and retain publisher attribution', async (t) => {
  const f = await fixture(t);
  await legacyArchive(f.global, 'library', ['alpha']);
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const oldUnit = '@local/library/alpha';
  const nextUnit = 'library/alpha';
  const oldKey = digest(JSON.stringify(['global', oldUnit]));
  const nextKey = digest(JSON.stringify(['global', nextUnit]));
  const publisher = digest('alice');
  const token = randomUUID();
  const sharing = {
    scope: 'global' as const,
    userId: 'alice',
    userName: 'Alice',
  };
  const registry = join(f.root, '.agents/skill-origins');
  await file(
    join(registry, `${oldKey}.${publisher}.json`),
    JSON.stringify({ sharing, unit: oldUnit, token }),
  );
  const stalePublisher = digest('previous-owner');
  await file(
    join(registry, `${oldKey}.${stalePublisher}.json`),
    JSON.stringify({
      sharing: { ...sharing, userId: 'previous-owner' },
      unit: oldUnit,
      token: randomUUID(),
    }),
  );
  await file(join(f.global, oldUnit, `.skill-origin-${oldKey}`), token);
  await migrateSkillLayouts(f.root, async () => {});
  await absent(join(registry, `${oldKey}.${publisher}.json`));
  await absent(join(registry, `${nextKey}.${stalePublisher}.json`));
  await absent(join(f.global, nextUnit, `.skill-origin-${oldKey}`));
  assert.deepEqual(
    JSON.parse(
      await readFile(join(registry, `${nextKey}.${publisher}.json`), 'utf8'),
    ),
    { sharing, unit: nextUnit, token },
  );
  assert.equal(
    await readFile(
      join(f.global, nextUnit, `.skill-origin-${nextKey}`),
      'utf8',
    ),
    token,
  );
  const origins = new SkillOrigins(f.global);
  assert.deepEqual(
    [...(await origins.find({ scope: 'global' }, f.global, [nextUnit]))],
    [[nextUnit, sharing]],
  );
  await migrateSkillLayouts(f.root, async () => {
    assert.fail('Origin migration must also be idempotent.');
  });
  assert.deepEqual(
    (await readdir(registry)).sort(),
    [`${nextKey}.${publisher}.json`, `${oldKey}.${stalePublisher}.json`].sort(),
  );
});

test('migration holds old and new installation locks through the database callback and resumes them after failure', async (t) => {
  const f = await fixture(t);
  await legacyArchive(f.global, 'library', ['alpha']);
  await legacyProject(f.global, 'owner/repository', 'entry');
  const locks = [
    '.@local.skill-install.lock',
    '.library.skill-install.lock',
    '.owner.skill-install.lock',
  ];
  const journal = join(f.root, '.agents/.skill-layout-migration.json');
  let firstId = '';
  const blocked = async () => {
    await assert.rejects(f.service.remove('library/alpha'), {
      code: 'SKILL_CONFLICT',
    });
    await assert.rejects(
      f.service.removeGroup('owner/repository', [
        'owner/repository/skills/entry',
      ]),
      { code: 'SKILL_CONFLICT' },
    );
  };
  await assert.rejects(
    migrateSkillLayouts(f.root, async (_, id) => {
      firstId = id;
      const pending = JSON.parse(await readFile(journal, 'utf8'));
      assert.equal(pending.id, id);
      assert.equal(pending.planning, undefined);
      for (const path of locks) {
        assert.ok(pending.locks.includes(join('.agents/skills', path)));
        assert.equal(
          await readlink(join(f.global, path)),
          `skill-layout-migration-${id}`,
        );
      }
      await blocked();
      throw new Error('reference migration interrupted');
    }),
    /reference migration interrupted/,
  );
  await blocked();
  const replaced = join(f.global, '.library.skill-install.lock');
  const foreignToken = `skill-layout-migration-${randomUUID()}`;
  await rm(replaced);
  await symlink(foreignToken, replaced);
  await assert.rejects(
    migrateSkillLayouts(f.root, async () => {
      assert.fail('A foreign lock must prevent journal replay.');
    }),
    /技能目录迁移冲突/,
  );
  assert.equal(await readlink(replaced), foreignToken);
  await rm(replaced);
  await symlink(`skill-layout-migration-${firstId}`, replaced);
  await migrateSkillLayouts(f.root, async (_, id) => {
    assert.equal(id, firstId);
    await blocked();
  });
  for (const path of locks) await absent(join(f.global, path));
  await absent(journal);
  await f.service.remove('library/alpha');
  await absent(join(f.global, 'library/alpha'));
});

test('active installer locks preserve conflicting groups and unrelated migrations release their locks', async (t) => {
  const f = await fixture(t);
  await legacyArchive(f.global, 'busy', ['alpha']);
  await legacyArchive(f.global, 'safe', ['beta']);
  const busy = join(f.global, '.busy.skill-install.lock');
  await mkdir(busy);
  await file(join(busy, 'foreign-owner'), 'keep');
  const warnings = await migrateSkillLayouts(f.root, async () => {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /busy/);
  assert.equal(await readFile(join(busy, 'foreign-owner'), 'utf8'), 'keep');
  assert.equal(
    await readFile(join(f.global, '@local/busy/alpha/SKILL.md'), 'utf8'),
    manifest('alpha'),
  );
  assert.equal(
    await readFile(join(f.global, 'safe/beta/SKILL.md'), 'utf8'),
    manifest('beta'),
  );
  await absent(join(f.global, '.safe.skill-install.lock'));
  await absent(join(f.global, '.@local.skill-install.lock'));
  await absent(join(f.root, '.agents/.skill-layout-migration.json'));
});

test('an interrupted preflight releases only journal-owned locks and restarts planning', async (t) => {
  const f = await fixture(t);
  await legacyArchive(f.global, 'library', ['alpha']);
  const id = randomUUID();
  const own = '.agents/skills/.@local.skill-install.lock';
  const foreign = '.agents/skills/.other.skill-install.lock';
  const journal = join(f.root, '.agents/.skill-layout-migration.json');
  await file(
    journal,
    JSON.stringify({
      id,
      planning: true,
      locks: [own, foreign],
      steps: [],
      globals: [],
      origins: [],
    }),
  );
  await symlink(`skill-layout-migration-${id}`, join(f.root, own));
  await mkdir(join(f.root, foreign));
  await migrateSkillLayouts(f.root, async (_, nextId) =>
    assert.notEqual(nextId, id),
  );
  await absent(join(f.root, own));
  assert.equal((await lstat(join(f.root, foreign))).isDirectory(), true);
  assert.equal(
    await readFile(join(f.global, 'library/alpha/SKILL.md'), 'utf8'),
    manifest('alpha'),
  );
  await absent(journal);
});

test('committed journal cleanup does not replay mutations or remove a new installer lock', async (t) => {
  const f = await fixture(t);
  await mkdir(f.global, { recursive: true });
  const id = randomUUID();
  const own = '.agents/skills/.old.skill-install.lock';
  const reused = '.agents/skills/.new.skill-install.lock';
  await symlink(`skill-layout-migration-${id}`, join(f.root, own));
  await mkdir(join(f.root, reused));
  const journal = join(f.root, '.agents/.skill-layout-migration.json');
  await file(
    journal,
    JSON.stringify({
      id,
      committed: true,
      locks: [own, reused],
      steps: [{ op: 'rmdir', path: 'must-not-replay' }],
      globals: [['old', 'new']],
      origins: [],
    }),
  );
  await migrateSkillLayouts(f.root, async () =>
    assert.fail('Committed references must not be applied twice.'),
  );
  await absent(join(f.root, own));
  assert.equal((await lstat(join(f.root, reused))).isDirectory(), true);
  await absent(journal);
});

test('empty archive cleanup honors the parent lock, removes Finder files and preserves unknown hidden files', async (t) => {
  const f = await fixture(t);
  await file(join(f.global, '@local/.DS_Store'), 'Finder metadata');
  const lock = join(f.global, '.@local.skill-install.lock');
  await mkdir(lock);
  assert.equal((await migrateSkillLayouts(f.root, async () => {})).length, 1);
  assert.equal(
    await readFile(join(f.global, '@local/.DS_Store'), 'utf8'),
    'Finder metadata',
  );
  await rm(lock, { recursive: true });
  await migrateSkillLayouts(f.root, async () => {});
  await absent(join(f.global, '@local'));
  await absent(lock);
  await file(join(f.global, '@local/.custom'), 'keep');
  await migrateSkillLayouts(f.root, async () => {});
  assert.equal(
    await readFile(join(f.global, '@local/.custom'), 'utf8'),
    'keep',
  );
  await absent(lock);
  await absent(join(f.root, '.agents/.skill-layout-migration.json'));
});
