import { FileContentError } from '../files/content/types.js';

const maxOutputChars = 100_000;

/** Tool-only view of complete parsed text. Never put this policy in the parser. */
export function readParsedTextRange(
  text: string,
  options: { offset?: number; limit?: number; showLineNumbers?: boolean },
) {
  const lines = text.split('\n');
  const start = (options.offset ?? 1) - 1;
  if (!Number.isInteger(start) || start < 0 || start >= lines.length)
    throw new FileContentError(
      'INVALID_OFFSET',
      `offset 应在 1 到 ${lines.length} 行之间。`,
    );
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit <= 0)
  )
    throw new FileContentError('INVALID_LIMIT', 'limit 应为正整数。');
  const requestedEnd = Math.min(
    lines.length,
    start + (options.limit ?? lines.length),
  );
  const numbered =
    (options.offset !== undefined || options.limit !== undefined) &&
    options.showLineNumbers !== false;
  const selected: string[] = [];
  let length = 0;
  let end = start;
  let clippedLine = false;
  for (let i = start; i < requestedEnd; i++) {
    const line = numbered ? `${i + 1}: ${lines[i]}` : lines[i]!;
    const available = maxOutputChars - length - (selected.length ? 1 : 0);
    if (line.length > available) {
      // Prefer whole lines so offset can retrieve the remainder without losing text.
      if (!selected.length) {
        let cut = available;
        if (cut > 0 && /[\uD800-\uDBFF]/.test(line[cut - 1]!)) cut--;
        selected.push(line.slice(0, cut));
        end = i + 1;
        clippedLine = true;
      }
      break;
    }
    selected.push(line);
    length += line.length + (selected.length > 1 ? 1 : 0);
    end = i + 1;
  }
  return {
    text: selected.join('\n'),
    numbered,
    totalLines: lines.length,
    startLine: start + 1,
    endLine: end,
    truncated: end < lines.length || clippedLine,
    // A single overlong line cannot be resumed with a line offset; be explicit.
    nextOffset: !clippedLine && end < lines.length ? end + 1 : undefined,
  };
}
