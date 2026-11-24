/** A market link can survive a login/reload without accepting arbitrary redirect URLs. */
export function validateLoginSearch(search: Record<string, unknown>): {
  returnTo?: string;
} {
  const target = search.returnTo;
  // The router merges this result into the raw query. Explicitly clear invalid values.
  return {
    returnTo:
      typeof target === 'string' && /^\/vibe-quant(?:[?#]|$)/.test(target)
        ? target
        : undefined,
  };
}
