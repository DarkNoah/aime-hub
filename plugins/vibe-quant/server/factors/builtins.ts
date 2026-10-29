import { createHash } from 'node:crypto';
import type {
  BuiltinFactorInfo,
  FactorDetail,
  FactorSummary,
} from '../../factor-types.js';
import { FACTOR_GROUPS } from '../../factor-groups.js';
import formulas from './builtins/formulas.json' with { type: 'json' };

const families: Record<string, { group: number; reference: string }> = {
  worldquant101: { group: 1, reference: 'https://arxiv.org/abs/1601.00991' },
  gtja191: {
    group: 2,
    reference: 'https://guorn.com/static/upload/file/3/134065454575605.pdf',
  },
  qlib158: {
    group: 3,
    reference:
      'https://github.com/microsoft/qlib/blob/main/qlib/contrib/data/loader.py',
  },
  qlib360: {
    group: 4,
    reference:
      'https://github.com/microsoft/qlib/blob/main/qlib/contrib/data/loader.py',
  },
};

function stableId(key: string) {
  const hash = createHash('sha256').update(`quant-factor:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const records = new Map<string, FactorDetail>();
const versions = new Map<string, FactorDetail['versions'][number]>();
for (const formula of formulas) {
  const family = families[formula.family];
  const group = FACTOR_GROUPS[family.group];
  const id = stableId(`${formula.family}:${formula.key}`);
  const source = [
    'from quant_sdk.alpha import ExpressionFactor',
    '',
    `# ${group.name} ${formula.key}`,
    `# 原始公式: ${formula.formula}`,
    ...formula.notes.map((note) => `# 口径: ${note}`),
    'class BuiltinAlpha(ExpressionFactor):',
    `    family = ${JSON.stringify(formula.family)}`,
    `    expression = ${JSON.stringify(formula.expression)}`,
    '',
  ].join('\n');
  const hash = createHash('sha256').update(source).digest('hex');
  const version = {
    id: stableId(`${formula.family}:${formula.key}:v1:${hash}`),
    factor_id: id,
    number: 1,
    source,
    source_hash: hash,
    parameters: {},
    note: '内置公式 v1；计算口径及原文勘误见因子详情。',
    created_at: '2026-10-29T00:00:00.000Z',
  };
  const builtin: BuiltinFactorInfo = {
    ...formula,
    reference: family.reference,
  };
  records.set(id, {
    id,
    name: formula.key,
    description: `${group.name} · ${formula.formula}`,
    enabled: true,
    revision: 1,
    version_count: 1,
    updated_at: version.created_at,
    group_id: group.id,
    source,
    parameters: {},
    versions: [version],
    builtin,
  });
  versions.set(version.id, version);
}

export function builtinSummaries(): FactorSummary[] {
  return [...records.values()].map(
    ({
      id,
      name,
      description,
      enabled,
      revision,
      version_count,
      updated_at,
      group_id,
      builtin,
    }) => ({
      id,
      name,
      description,
      enabled,
      revision,
      version_count,
      updated_at,
      group_id,
      builtin: builtin && {
        family: builtin.family,
        key: builtin.key,
        fields: builtin.fields,
        cross_sectional: builtin.cross_sectional,
      },
    }),
  );
}
export const builtinDetail = (id: string) => records.get(id);
export const builtinVersion = (id: string) => versions.get(id);
export const builtinVersions = () => [...versions.values()];
