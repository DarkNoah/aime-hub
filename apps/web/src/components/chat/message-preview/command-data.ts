export function commandRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type CommandResult = {
  output: string;
  sessionId?: number;
  exitCode?: number;
  seconds?: number;
  tokens?: number;
  truncated: boolean;
};

export function parseCommandResult(value: unknown): CommandResult | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const data = commandRecord(value);
  if (!data || typeof data.output !== 'string') return null;
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  return {
    output: data.output,
    sessionId:
      finite(data.session_id) &&
      Number.isSafeInteger(data.session_id) &&
      data.session_id > 0
        ? data.session_id
        : undefined,
    exitCode:
      finite(data.exit_code) && Number.isInteger(data.exit_code)
        ? data.exit_code
        : undefined,
    seconds:
      finite(data.wall_time_seconds) && data.wall_time_seconds >= 0
        ? data.wall_time_seconds
        : undefined,
    tokens:
      finite(data.original_token_count) &&
      Number.isInteger(data.original_token_count) &&
      data.original_token_count >= 0
        ? data.original_token_count
        : undefined,
    truncated: data.truncated === true,
  };
}

/** Display control characters as keys, while copying still uses the original bytes. */
export function stdinSegments(chars: string) {
  return (
    chars
      // eslint-disable-next-line no-control-regex -- Terminal control bytes are deliberately displayed as key labels.
      .split(/(\r\n|[\x00-\x1f\x7f])/)
      .filter(Boolean)
      .map((text) => {
        const keys: Record<string, string> = {
          '\r\n': 'Enter',
          '\n': 'Enter',
          '\r': 'Enter',
          '\t': 'Tab',
          '\x1b': 'Esc',
          '\x7f': 'Backspace',
          '\b': 'Backspace',
        };
        const code = text.charCodeAt(0);
        const key =
          keys[text] ??
          (text.length === 1 && code < 32
            ? `Ctrl+${String.fromCharCode(code + 64)}`
            : undefined);
        return { text, key, newline: key === 'Enter' };
      })
  );
}
