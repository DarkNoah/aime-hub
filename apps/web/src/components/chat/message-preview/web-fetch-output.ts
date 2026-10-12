export type WebFetchOutput = {
  content: string;
  url?: string;
  title?: string;
  contentType?: string;
  provider?: string;
  fallback: boolean;
  truncated: boolean;
  isError: boolean;
};

export function parseWebFetchOutput(output: unknown): WebFetchOutput | null {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // Older tools returned the page text directly.
      value = { content: value };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.content !== 'string' ||
    ['url', 'title', 'contentType', 'provider'].some(
      (key) => data[key] !== undefined && typeof data[key] !== 'string',
    ) ||
    ['fallback', 'truncated', 'ok', 'isError'].some(
      (key) => data[key] !== undefined && typeof data[key] !== 'boolean',
    )
  )
    return null;
  return {
    content: data.content,
    url: data.url as string | undefined,
    title: data.title as string | undefined,
    contentType: data.contentType as string | undefined,
    provider: data.provider as string | undefined,
    fallback: data.fallback === true,
    truncated: data.truncated === true,
    isError: data.isError === true || data.ok === false,
  };
}
