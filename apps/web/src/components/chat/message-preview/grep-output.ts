export type GrepLine = {
  line: number;
  column?: number;
  content: string;
  gapBefore: boolean;
};

export type GrepFile = { path: string; lines: GrepLine[] };

// Mastra's grep emits a summary, then path:line:column matches and path:line- context.
// Keep unfamiliar/truncated lines visible instead of guessing at their structure.
export function parseGrepOutput(output: unknown) {
  if (typeof output !== 'string') return null;
  const [summary, separator, ...lines] = output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
  const counts = /^(\d+) match(?:es)? across (\d+) files?(.*)$/.exec(summary);
  if (!counts || separator !== '---') return null;

  const files = new Map<string, GrepFile>();
  const unparsed: string[] = [];
  let gapBefore = false;
  for (const value of lines) {
    if (value === '--') {
      gapBefore = true;
      continue;
    }
    const match = /^(.+?):([1-9]\d*):([1-9]\d*): (.*)$/.exec(value);
    const context = match ? null : /^(.+?):([1-9]\d*)- (.*)$/.exec(value);
    const parts = match ?? context;
    if (!parts) {
      if (value) unparsed.push(value);
      continue;
    }
    const [, path, line] = parts;
    let file = files.get(path);
    if (!file) {
      file = { path, lines: [] };
      files.set(path, file);
    }
    const previous = file.lines.at(-1);
    file.lines.push({
      line: Number(line),
      column: match ? Number(match[3]) : undefined,
      content: match ? match[4] : parts[3],
      gapBefore:
        !!previous && (gapBefore || previous.line + 1 !== Number(line)),
    });
    gapBefore = false;
  }
  return {
    matchCount: Number(counts[1]),
    fileCount: Number(counts[2]),
    note: counts[3].trim(),
    files: [...files.values()],
    unparsed: unparsed.join('\n'),
  };
}
