import type { KnowledgeField } from '@aime/shared/knowledge';
import { ThreadError } from '../threads/errors.js';
import { fieldParameter, fieldTypes, validateMetadata } from './fields.js';

type Token = { kind: 'word' | 'string' | 'number' | 'symbol'; value: string };
const invalid = () => new ThreadError('KNOWLEDGE_FILTER_INVALID', 400);

/** Parse the aime-chat WHERE subset. Identifiers are allowlisted and every value is bound. */
export function compileKnowledgeFilter(
  expression: string,
  fields: KnowledgeField[],
  parameters: unknown[],
) {
  if (!expression.trim() || expression.length > 2000) throw invalid();
  const tokens: Token[] = [];
  const lexer =
    /\s+|'(?:''|[^'])*'|(?:<=|>=|<>|!=|[=<>(),])|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[a-zA-Z_][a-zA-Z0-9_]*/gy;
  let position = 0;
  while (position < expression.length) {
    lexer.lastIndex = position;
    const match = lexer.exec(expression);
    if (!match) throw invalid();
    position = lexer.lastIndex;
    const value = match[0];
    if (/^\s/.test(value)) continue;
    tokens.push(
      value.startsWith("'")
        ? { kind: 'string', value: value.slice(1, -1).replaceAll("''", "'") }
        : {
            kind: /^[a-zA-Z_]/.test(value)
              ? 'word'
              : /^-?\d/.test(value)
                ? 'number'
                : 'symbol',
            value,
          },
    );
  }
  let cursor = 0;
  const peek = (value: string) =>
    tokens[cursor]?.kind !== 'string' &&
    tokens[cursor]?.value.toUpperCase() === value;
  const consume = (value: string) => {
    if (!peek(value)) throw invalid();
    cursor++;
  };
  function literal(field: KnowledgeField) {
    const token = tokens[cursor++];
    if (!token) throw invalid();
    const raw =
      token.kind === 'string'
        ? token.value
        : token.kind === 'number'
          ? Number(token.value)
          : token.kind === 'word' && /^(true|false)$/i.test(token.value)
            ? token.value.toLowerCase() === 'true'
            : undefined;
    if (raw === undefined) throw invalid();
    const parsed = validateMetadata([field], { [field.name]: raw });
    parameters.push(fieldParameter(field, parsed[field.name]));
    return `$${parameters.length}::${fieldTypes[field.type]}`;
  }
  function comparison(depth: number): string {
    if (depth > 32) throw invalid();
    if (peek('(')) {
      cursor++;
      const sql = or(depth + 1);
      consume(')');
      return `(${sql})`;
    }
    const identifier = tokens[cursor++];
    if (identifier?.kind !== 'word') throw invalid();
    const field = fields.find((f) => f.name === identifier.value);
    if (!field) throw invalid();
    const column = `c."${field.name}"`;
    if (peek('IS')) {
      cursor++;
      const not = peek('NOT');
      if (not) cursor++;
      consume('NULL');
      return `${column} IS ${not ? 'NOT ' : ''}NULL`;
    }
    const not = peek('NOT');
    if (not) cursor++;
    if (peek('IN')) {
      cursor++;
      consume('(');
      const values = [literal(field)];
      while (peek(',')) {
        cursor++;
        values.push(literal(field));
      }
      consume(')');
      return `${column} ${not ? 'NOT ' : ''}IN (${values.join(',')})`;
    }
    if (peek('LIKE')) {
      if (field.type !== 'text') throw invalid();
      cursor++;
      return `${column} ${not ? 'NOT ' : ''}LIKE ${literal(field)}`;
    }
    if (not) throw invalid();
    const operator = tokens[cursor++];
    if (
      operator?.kind !== 'symbol' ||
      !['=', '!=', '<>', '<', '<=', '>', '>='].includes(operator.value)
    )
      throw invalid();
    if (
      ['blob', 'json', 'boolean'].includes(field.type) &&
      !['=', '!=', '<>'].includes(operator.value)
    )
      throw invalid();
    return `${column} ${operator.value} ${literal(field)}`;
  }
  function and(depth: number): string {
    let sql = comparison(depth);
    while (peek('AND')) {
      cursor++;
      sql = `(${sql} AND ${comparison(depth)})`;
    }
    return sql;
  }
  function or(depth: number): string {
    let sql = and(depth);
    while (peek('OR')) {
      cursor++;
      sql = `(${sql} OR ${and(depth)})`;
    }
    return sql;
  }
  const result = or(0);
  if (cursor !== tokens.length) throw invalid();
  return result;
}
