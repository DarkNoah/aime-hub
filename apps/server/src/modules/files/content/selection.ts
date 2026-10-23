import { FileContentError } from './types.js';

/** Normalize explicit 1-based selections without silently reading different pages. */
export function pageSelection(value: unknown, name: string) {
  if (value === undefined) return undefined;
  const text = (Array.isArray(value) ? value.join(',') : String(value)).replace(
    /\s/g,
    '',
  );
  let previous = 0;
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(text))
    throw new FileContentError(
      'INVALID_FILE_PARAMETERS',
      `${name} 应为页码范围，例如 1-3,5。`,
    );
  for (const item of text.split(',')) {
    const [start, end = start] = item.split('-').map(Number) as [
      number,
      number?,
    ];
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start <= previous ||
      end < start
    )
      throw new FileContentError(
        'INVALID_FILE_PARAMETERS',
        `${name} 应使用从 1 开始、按升序且不重叠的页码范围。`,
      );
    previous = end;
  }
  return text;
}

export function includesPage(selection: string, page: number) {
  return selection.split(',').some((item) => {
    const [start, end = start] = item.split('-').map(Number) as [
      number,
      number?,
    ];
    return page >= start && page <= end;
  });
}
