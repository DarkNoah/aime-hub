import type { TestContext } from 'node:test';

export function mockRpcFetch(
  t: TestContext,
  handler: (
    request: Request,
    init: RequestInit,
  ) => Response | Promise<Response>,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://localhost' } },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  t.mock.method(globalThis, 'fetch', handler);
}
export const rpcResponse = (value: unknown) => Response.json({ json: value });
export const rpcFailure = (code: string, status: number) =>
  Response.json(
    { json: { defined: false, code, status, message: code } },
    { status },
  );
export const nextTick = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
