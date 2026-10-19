/** Stop waiting even when an underlying client does not honor cancellation. */
export async function withAbortSignal<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
      run(),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
