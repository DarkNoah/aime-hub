export function formatTokens(tokens: number | undefined, language: string) {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0)
    return '—';
  return tokens > 1_000
    ? `${(tokens / 1_000).toLocaleString(language, { maximumFractionDigits: 1 })}k`
    : tokens.toLocaleString(language);
}
