/** CDP commands do not inherit Playwright's navigation/action timeouts. */
export async function browserOperation<T>(
  stage: string,
  operation: Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          console.warn('Browser operation timed out', { stage, timeoutMs });
          reject(new Error(`Browser operation timed out: ${stage}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
