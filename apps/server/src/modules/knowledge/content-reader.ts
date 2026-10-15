import { execFile } from 'node:child_process';
import { rgPath } from '@vscode/ripgrep';

// Only an argv subset is accepted; no shell, file paths, pipelines or substitutions.
function grepArguments(input: string): string[] {
  if (!/^(rg|grep)\s/.test(input)) return ['-e', input];
  const tokens: string[] = [];
  const pattern = /\s+|'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"|;&<>`$]+/gy;
  let offset = 0;
  while (offset < input.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(input);
    if (!match) throw new Error('Unsupported grep command syntax');
    offset = pattern.lastIndex;
    const token = match[0];
    if (!token.trim()) continue;
    tokens.push(
      token[0] === "'"
        ? token.slice(1, -1)
        : token[0] === '"'
          ? token.slice(1, -1).replace(/\\(["\\])/g, '$1')
          : token,
    );
  }
  tokens.shift();
  const args: string[] = [];
  let hasPattern = false;
  const flags: Record<string, string> = {
    i: '--ignore-case',
    F: '--fixed-strings',
    w: '--word-regexp',
    x: '--line-regexp',
    v: '--invert-match',
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^-[inEFwxv]+$/.test(token)) {
      for (const flag of token.slice(1))
        if (flags[flag]) args.push(flags[flag]);
    } else if (Object.values(flags).includes(token)) args.push(token);
    else if (token === '--line-number' || token === '--extended-regexp')
      continue;
    else if (
      token === '-e' ||
      token === '--regexp' ||
      token.startsWith('--regexp=')
    ) {
      const value = token.startsWith('--regexp=')
        ? token.slice(9)
        : tokens[++i];
      if (value === undefined) throw new Error('Missing grep pattern');
      args.push('-e', value);
      hasPattern = true;
    } else if (
      /^-(A|B|C)(\d+)?$/.test(token) ||
      /^--(after-context|before-context|context)(=\d+)?$/.test(token)
    ) {
      const parts = token.match(
        /^(-[ABC]|--(?:after-context|before-context|context))(?:=)?(\d+)?$/,
      )!;
      const value = parts[2] ?? tokens[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) > 2000)
        throw new Error('Invalid grep context');
      args.push(parts[1]!, value);
    } else {
      if (token.startsWith('-') || hasPattern)
        throw new Error('Grep paths and this option are not supported');
      args.push('-e', token);
      hasPattern = true;
    }
  }
  if (!hasPattern) throw new Error('Missing grep pattern');
  return args;
}

export async function readKnowledgeContent(
  content: string,
  options: {
    pattern?: string;
    offset?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {},
) {
  const offset = options.offset ?? 0;
  const limit = Math.min(options.limit ?? 2000, 2000);
  let entries: { lineNumber: number; text: string }[];
  if (options.pattern) {
    const args = [
      '--json',
      '--text',
      '--no-config',
      '--no-messages',
      ...grepArguments(options.pattern),
      '-',
    ];
    // The bounded source is passed over stdin, never interpolated into a command.
    const child = execFile(rgPath, args, {
      timeout: 5000,
      maxBuffer: 20 * 1024 * 1024,
      signal: options.signal,
    });
    child.stdin?.on('error', () => undefined);
    const result = new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (data: string) => {
        stdout += data;
      });
      child.stderr?.on('data', (data: string) => {
        stderr += data;
      });
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 || code === 1
          ? resolve(stdout)
          : reject(new Error(stderr.trim() || 'Knowledge grep failed')),
      );
    });
    child.stdin?.end(content);
    const output = await result;
    entries = output
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const event = JSON.parse(line) as {
          type: string;
          data?: { line_number?: number; lines?: { text?: string } };
        };
        return ['match', 'context'].includes(event.type) &&
          event.data?.line_number
          ? [
              {
                lineNumber: event.data.line_number,
                text: (event.data.lines?.text ?? '').replace(/\r?\n$/, ''),
              },
            ]
          : [];
      });
  } else
    entries = content
      ? content.split(/\r?\n/).map((text, i) => ({ lineNumber: i + 1, text }))
      : [];
  let text = '';
  let consumed = 0;
  let truncated = false;
  const lines: { lineNumber: number; text: string }[] = [];
  for (const entry of entries.slice(offset, offset + limit)) {
    const value = entry.text.slice(0, 2000);
    const formatted = `${entry.lineNumber}: ${value}${entry.text.length > 2000 ? '…' : ''}\n`;
    if (text.length + formatted.length > 40_000) {
      truncated = true;
      break;
    }
    text += formatted;
    consumed++;
    truncated ||= entry.text.length > 2000;
    lines.push({ lineNumber: entry.lineNumber, text: value });
  }
  const nextOffset =
    offset + consumed < entries.length ? offset + consumed : null;
  return {
    content: text,
    lines,
    totalLines: entries.length,
    nextOffset,
    truncated: truncated || nextOffset !== null,
  };
}
