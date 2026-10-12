export type WebSearchResult = {
  title: string;
  href: string;
  snippet?: string;
};

export type WebSearchOutput = {
  results: WebSearchResult[];
  provider?: string;
  fallback: boolean;
  isError: boolean;
  message?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseWebSearchOutput(output: unknown): WebSearchOutput | null {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.results) ||
    (value.provider !== undefined && typeof value.provider !== 'string') ||
    (value.fallback !== undefined && typeof value.fallback !== 'boolean') ||
    (value.isError !== undefined && typeof value.isError !== 'boolean') ||
    (value.message !== undefined && typeof value.message !== 'string')
  )
    return null;

  const results: WebSearchResult[] = [];
  for (const result of value.results) {
    if (
      !isRecord(result) ||
      typeof result.title !== 'string' ||
      typeof result.href !== 'string' ||
      (result.snippet !== undefined && typeof result.snippet !== 'string')
    )
      return null;
    results.push({
      title: result.title,
      href: result.href,
      snippet: result.snippet,
    });
  }
  return {
    results,
    provider: value.provider,
    fallback: value.fallback === true,
    isError: value.isError === true,
    message: value.message,
  };
}

export { webPreviewLink as webSearchLink } from './web-link.js';
