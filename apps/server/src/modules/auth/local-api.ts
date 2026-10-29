import { randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 15 * 60_000;
/** Process-local delegated credentials; never a browser session or a durable API key. */
export class LocalApiAccess {
  private tokens = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private readonly baseUrl: string,
    private readonly isUserActive: (userId: string) => Promise<boolean>,
    private readonly now = Date.now,
  ) {}

  environment(userId: string | undefined): Record<string, string> {
    // No fallback to the thread creator: a shared thread can change authors.
    if (!userId || userId === 'system') return {};
    const now = this.now();
    for (const [token, value] of this.tokens)
      if (value.expiresAt <= now) this.tokens.delete(token);
    const token = `local_${randomBytes(32).toString('base64url')}`;
    this.tokens.set(token, { userId, expiresAt: now + TOKEN_TTL_MS });
    return { APP_API_URL: this.baseUrl, APP_API_TOKEN: token };
  }

  async authenticate(authorization: string): Promise<string | null> {
    const match = /^Bearer (local_[A-Za-z0-9_-]+)$/i.exec(authorization);
    if (!match) return null;
    const credential = this.tokens.get(match[1]);
    if (!credential) return null;
    if (credential.expiresAt <= this.now()) {
      this.tokens.delete(match[1]);
      return null;
    }
    // Check account removal/disablement on every request, not just issuance.
    return (await this.isUserActive(credential.userId))
      ? credential.userId
      : null;
  }
}
