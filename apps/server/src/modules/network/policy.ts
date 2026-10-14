/** Explicit deployment opt-in for unrestricted HTTP(S) destinations. */
export function allowAllNetworks(): boolean {
  return process.env.ALLOW_ALL_NETWORKS === 'true';
}
