const previewLength = 30;
const base64Text = /^[A-Za-z0-9+/_-]+={0,2}$/;
const base64Field = /^(?:base64|b64_json|b64|data|image|audio|file_data)$/i;
const dataUrl = /(data:[^\s,"<>]*;base64,)([A-Za-z0-9+/_=-]+)/gi;

/** For log/inspector copies only; never use this value as model input. */
export function truncateBase64(value: string): string {
  return value.length > previewLength
    ? `${value.slice(0, previewLength)}…`
    : value;
}

function truncateString(value: string, key: string): string {
  // Parse string-encoded tool results before scanning embedded data URLs, so
  // other base64 fields in that same document are also visited.
  if (/^\s*[[{]/.test(value)) {
    const shortened = truncateJsonBody(value);
    if (shortened !== value) return shortened;
  }
  const withShortDataUrls = value.replace(
    dataUrl,
    (_match, prefix: string, data: string) =>
      `${prefix}${truncateBase64(data)}`,
  );
  if (withShortDataUrls !== value) return withShortDataUrls;
  // Explicit media fields cover short payloads. Be conservative for unlabelled
  // strings so ordinary short identifiers and words remain readable.
  if (
    value.length > previewLength &&
    (base64Field.test(key) || value.length >= 128) &&
    base64Text.test(value)
  )
    return truncateBase64(value);
  return value;
}

/** JSON's replacer visits every nested object/array without mutating the source. */
export function stringifyLogJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (key, child: unknown) =>
      typeof child === 'string' ? truncateString(child, key) : child,
    space,
  );
}

/** Preserve original whitespace when no payload was shortened, and tolerate partial JSON. */
export function truncateJsonBody(body: string, space?: number): string {
  try {
    let changed = false;
    const parsed: unknown = JSON.parse(body, (key, value: unknown) => {
      if (typeof value !== 'string') return value;
      const shortened = truncateString(value, key);
      changed ||= shortened !== value;
      return shortened;
    });
    return changed || space !== undefined
      ? JSON.stringify(parsed, null, space)
      : body;
  } catch {
    return body;
  }
}
