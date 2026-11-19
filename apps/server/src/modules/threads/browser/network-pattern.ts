import { RE2JS } from 're2js';
import type { NetworkRequestDetail } from './network-store.js';

const searchableFields = [
  'url',
  'method',
  'status',
  'resourceType',
  'state',
  'mimeType',
  'error',
  'requestHeaders',
  'responseHeaders',
  'requestBody',
  'responseBody',
] as const;

type SearchableField = (typeof searchableFields)[number];
export type NetworkPatternMatch = { field: SearchableField; snippet: string };

function snippet(value: string, start: number, end: number) {
  let from = Math.max(0, start - 40);
  let to = Math.min(value.length, from + 156, end + 40);
  // Matcher offsets refer to UTF-16 code units. Keep both halves of an emoji.
  if ((value.codePointAt(from - 1) ?? 0) > 0xffff) from--;
  if ((value.codePointAt(to - 1) ?? 0) > 0xffff) to++;
  return (
    (from ? '…' : '') + value.slice(from, to) + (to < value.length ? '…' : '')
  );
}

export function compileNetworkPattern(
  pattern: string,
): (record: NetworkRequestDetail) => NetworkPatternMatch | undefined {
  if (pattern.length > 512)
    throw new Error('Network search pattern is too long');
  let regex: RE2JS;
  try {
    regex = RE2JS.compile(pattern, RE2JS.MULTILINE);
  } catch (error) {
    throw new Error(
      'Invalid network search pattern: ' + (error as Error).message,
    );
  }
  if (regex.programSize() > 512)
    throw new Error('Network search pattern is too complex');

  function match(field: SearchableField, text: string) {
    const matcher = regex.matcher(text);
    if (matcher.find())
      return { field, snippet: snippet(text, matcher.start(), matcher.end()) };
  }
  return (record) => {
    for (const field of searchableFields) {
      const value = record[field];
      if (value === undefined) continue;
      if (typeof value === 'object') {
        for (const [name, header] of Object.entries(value)) {
          const hit = match(field, name + ': ' + header);
          if (hit) return hit;
        }
      } else {
        const hit = match(field, String(value));
        if (hit) return hit;
      }
    }
  };
}
