import { z } from 'zod';

export const searchResultSchema = z.object({
  title: z.string(),
  href: z.string(),
  snippet: z.string().optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
export type WebSearchInput = { query: string; numResults: number };
export type WebSearchOptions = { abortSignal?: AbortSignal };
export interface WebSearchProvider {
  readonly id: string;
  webSearch(
    input: WebSearchInput,
    options?: WebSearchOptions,
  ): Promise<SearchResult[]>;
}

export function searchResultUrl(
  value: string,
  base?: string,
): string | undefined {
  try {
    const url = new URL(value, base);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
