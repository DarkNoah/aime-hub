import { setImmediate as yieldLoop } from 'node:timers/promises';
import {
  getQuickJS,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten';

type Options = {
  code: string;
  signal: AbortSignal;
  deadline: number;
  catalog: { name: string; description: string; inputSchema?: unknown }[];
  dispatch: (name: string, input: unknown) => Promise<unknown>;
  emit: (kind: 'text' | 'image', value: unknown) => void;
};

/** Only JSON strings cross the WASM boundary; no host objects/functions reach guest code. */
export async function runExec(options: Options) {
  const engine = await getQuickJS();
  options.signal.throwIfAborted();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();
  let closed = false;
  let calls = 0;
  let cpuMs = 0;
  let sliceStart = performance.now();
  let wake: (() => void) | undefined;
  const pending = new Set<QuickJSDeferredPromise>();
  const completed: (() => void)[] = [];
  let program: QuickJSHandle | undefined;
  let parse: QuickJSHandle | undefined;
  const interrupt = () =>
    options.signal.aborted ||
    Date.now() >= options.deadline ||
    cpuMs + performance.now() - sliceStart > 1000;
  runtime.setInterruptHandler(interrupt);
  const execute = <T>(operation: () => T): T => {
    sliceStart = performance.now();
    try {
      return operation();
    } finally {
      cpuMs += performance.now() - sliceStart;
    }
  };
  const check = () => {
    options.signal.throwIfAborted();
    if (Date.now() >= options.deadline)
      throw new Error('exec execution timed out');
    if (cpuMs > 1000) throw new Error('exec CPU time limit exceeded');
  };
  const notify = () => wake?.();
  options.signal.addEventListener('abort', notify);

  try {
    parse = vm.unwrapResult(vm.evalCode('JSON.parse'));
    const deserialize = (value: unknown) => {
      if (value === undefined) return vm.undefined.dup();
      const json = JSON.stringify(value);
      if (json === undefined) return vm.undefined.dup();
      if (Buffer.byteLength(json) > 16 * 1024 * 1024)
        throw new Error('Nested tool result exceeds 16 MiB');
      const text = vm.newString(json);
      try {
        return vm.unwrapResult(vm.callFunction(parse!, vm.undefined, text));
      } finally {
        text.dispose();
      }
    };
    const emit = vm.newFunction('_emit', (kind, json) => {
      check();
      const type = vm.getString(kind);
      if (type !== 'text' && type !== 'image')
        throw new Error('Unknown output type');
      options.emit(type, JSON.parse(vm.getString(json)));
      return vm.undefined;
    });
    const call = vm.newFunction('_call', (name, args) => {
      check();
      if (++calls > 256 || pending.size >= 32)
        throw new Error('exec tool call limit exceeded');
      const toolName = vm.getString(name);
      const input = JSON.parse(vm.getString(args));
      const deferred = vm.newPromise();
      pending.add(deferred);
      const settle = (value: unknown, rejected: boolean) => {
        if (closed) return;
        completed.push(() => {
          try {
            const handle = rejected
              ? vm.newError(
                  value instanceof Error ? value.message : String(value),
                )
              : deserialize(value);
            try {
              if (rejected) deferred.reject(handle);
              else deferred.resolve(handle);
            } finally {
              handle.dispose();
            }
          } catch (error) {
            const handle = vm.newError(
              error instanceof Error ? error.message : String(error),
            );
            deferred.reject(handle);
            handle.dispose();
          } finally {
            pending.delete(deferred);
            deferred.dispose();
          }
        });
        notify();
      };
      // Start on the next host microtask: synchronous guest completion cancels unawaited calls.
      void Promise.resolve()
        .then(() => {
          if (closed) return;
          return options.dispatch(toolName, input);
        })
        .then(
          (result) => settle(result, false),
          (error) => settle(error, true),
        );
      return deferred.handle;
    });
    vm.setProp(vm.global, '_emit', emit);
    vm.setProp(vm.global, '_call', call);
    emit.dispose();
    call.dispose();
    const bootstrap = `(() => {
      const emit = globalThis._emit, call = globalThis._call;
      delete globalThis._emit; delete globalThis._call;
      const stringify = JSON.stringify;
      const catalog = ${JSON.stringify(options.catalog)};
      const tools = Object.create(null);
      for (const {name, inputSchema} of catalog) {
        const invoke = input => call(name, stringify(input === undefined ? {} : input));
        Object.defineProperty(invoke, 'inputSchema', { value: inputSchema, enumerable: true });
        tools[name] = Object.freeze(invoke);
      }
      Object.defineProperties(globalThis, {
        tools: { value: Object.freeze(tools) },
        ALL_TOOLS: { value: Object.freeze(catalog.map(({name, description}) => Object.freeze({name, description}))) },
        text: { value: value => {
          let json;
          try { json = stringify(value); } catch { json = stringify(String(value)); }
          emit('text', json === undefined ? stringify(String(value)) : json);
        } },
        image: { value: value => emit('image', stringify(value)) },
      });
    })()`;
    execute(() =>
      vm.unwrapResult(vm.evalCode(bootstrap, 'exec-bootstrap.js')).dispose(),
    );
    program = execute(() =>
      vm.unwrapResult(
        vm.evalCode(`(async () => {\n${options.code}\n})()`, 'exec.js'),
      ),
    );
    while (true) {
      check();
      execute(() => {
        for (const settle of completed.splice(0)) settle();
        const jobs = runtime.executePendingJobs(50);
        if (jobs.error) {
          try {
            throw new Error(String(jobs.error.context.dump(jobs.error)));
          } finally {
            jobs.error.dispose();
          }
        }
      });
      const state = execute(() => vm.getPromiseState(program!));
      if (state.type === 'fulfilled') {
        state.value.dispose();
        break;
      }
      if (state.type === 'rejected') {
        try {
          const error = execute(() => vm.dump(state.error)) as
            { message?: string } | string;
          throw new Error(
            typeof error === 'string'
              ? error
              : (error?.message ?? 'JavaScript execution failed'),
          );
        } finally {
          state.error.dispose();
        }
      }
      if (!runtime.hasPendingJob() && completed.length === 0) {
        if (pending.size === 0)
          throw new Error('Script is awaiting a promise that cannot settle');
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (options.signal.aborted || completed.length) resolve();
        });
        wake = undefined;
      } else await yieldLoop();
    }
  } finally {
    closed = true;
    options.signal.removeEventListener('abort', notify);
    for (const deferred of pending) deferred.dispose();
    program?.dispose();
    parse?.dispose();
    vm.dispose();
    runtime.dispose();
  }
}
