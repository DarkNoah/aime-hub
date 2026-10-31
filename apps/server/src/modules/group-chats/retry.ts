import { StreamErrorRetryProcessor } from '@mastra/core/processors';

export const GROUP_CHAT_MAX_RETRIES = 3;

// Mastra already handles provider retry metadata and OpenAI stream errors.
// Fetch/Undici transport failures can instead arrive as an Error.cause code;
// the native processor walks that chain for each matcher.
function isTransientTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  if (
    typeof code === 'string' &&
    /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/i.test(
      code,
    )
  )
    return true;
  return (
    error instanceof Error && /ECONNRESET|socket hang up/i.test(error.message)
  );
}

export function createGroupChatRetryProcessor() {
  return new StreamErrorRetryProcessor({
    maxRetries: GROUP_CHAT_MAX_RETRIES,
    delayMs: ({ retryCount }) => 1_000 * 2 ** retryCount,
    maxRetryAfterMs: 30_000,
    matchers: [isTransientTransportError],
  });
}
