import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FactorVersion } from '../../factor-types.js';
import type { FactorStore } from './store.js';

/** Only literal pinned versions are supported; no mutable lookup during strategy execution. */
export function factorReferences(source: string): string[] {
  // Tokenize comments and strings rather than matching examples inside docstrings.
  const tokens: { kind: 'string' | 'other'; value: string }[] = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote =
        source.slice(i, i + 3) === char.repeat(3) ? char.repeat(3) : char;
      i += quote.length;
      let value = '';
      while (i < source.length && source.slice(i, i + quote.length) !== quote) {
        if (source[i] === '\\') {
          value += source.slice(i, i + 2);
          i += 2;
        } else value += source[i++];
      }
      i += quote.length;
      tokens.push({ kind: 'string', value });
    } else {
      const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i))?.[0] ?? char;
      tokens.push({ kind: 'other', value: word });
      i += word.length;
    }
  }
  const ids = new Set<string>();
  tokens.forEach((token, i) => {
    const argument = tokens[i + 2];
    if (
      token.kind === 'other' &&
      token.value === 'load_factor' &&
      tokens[i + 1]?.value === '(' &&
      argument?.kind === 'string' &&
      /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(argument.value) &&
      (tokens[i + 3]?.value === ')' ||
        (tokens[i + 3]?.value === ',' && tokens[i + 4]?.value === ')'))
    )
      ids.add(argument.value);
  });
  return [...ids];
}

export async function writeFactorBundle(
  store: Pick<FactorStore, 'version'>,
  source: string,
  directory: string,
) {
  const roots = factorReferences(source);
  if (!roots.length) return;
  const versions: Record<string, FactorVersion> = {};
  const visiting = new Set<string>();
  const visit = async (id: string) => {
    if (visiting.has(id)) throw new Error('因子版本存在循环依赖');
    if (versions[id]) return;
    if (Object.keys(versions).length >= 50)
      throw new Error('一次运行最多引用 50 个因子版本');
    visiting.add(id);
    const version = await store.version(id);
    versions[id] = version;
    for (const dependency of factorReferences(version.source))
      await visit(dependency);
    visiting.delete(id);
  };
  for (const id of roots) await visit(id);
  await writeFile(
    join(directory, 'factor-library.json'),
    JSON.stringify(versions),
    { mode: 0o600 },
  );
}
