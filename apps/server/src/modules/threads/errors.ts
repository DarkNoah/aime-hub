export class ThreadError extends Error {
  constructor(
    public code: string,
    public status = 400,
    message = code,
  ) {
    super(message);
  }
}

export function threadErrorMessage(error: unknown): string {
  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? error.message
        : undefined;
  // Mastra may serialize provider error objects into an Error's message.
  if (typeof message === 'string' && message.trimStart().startsWith('{')) {
    try {
      return threadErrorMessage(JSON.parse(message));
    } catch {
      // Plain text error messages can also start with a brace.
    }
  }
  // Persist only the message, not provider request bodies or other error fields.
  return typeof message === 'string' && message.trim()
    ? message
    : 'CHAT_FAILED';
}
