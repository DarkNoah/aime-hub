import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';

/** Same trusted-admin boundary as backtests; no host credentials enter the child environment. */
export function runSignalProcess(
  python: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  handle: (message: Record<string, unknown>) => Promise<unknown>,
  secrets: string[] = [],
) {
  signal.throwIfAborted();
  return new Promise<void>((_resolve, reject) => {
    const child = spawn(python, ['-B', '-u', ...args], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: `${dirname(python)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        ...(isAbsolute(python)
          ? { VIRTUAL_ENV: dirname(dirname(python)) }
          : {}),
        HOME: cwd,
        TMPDIR: cwd,
        PYTHONNOUSERSITE: '1',
        PYTHONIOENCODING: 'utf-8',
        ...(process.env.QUANT_KRONOS_ROOT
          ? { QUANT_KRONOS_ROOT: process.env.QUANT_KRONOS_ROOT }
          : {}),
        ...(process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
    });
    let buffer = '',
      stderr = '',
      failed: Error | undefined,
      escalation: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve(),
      queued = 0,
      lastMessage = Date.now();
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') child.kill(kind);
        else if (child.pid) process.kill(-child.pid, kind);
      } catch {
        /* exited */
      }
    };
    const stop = () => {
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 1500);
    };
    const fail = (error: unknown) => {
      failed = error instanceof Error ? error : new Error('实时策略运行失败');
      stop();
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastMessage > 90000)
        fail(new Error('实时策略长时间未响应，已停止并等待重试'));
    }, 5000);
    signal.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {
      /* Child exit is handled below. */
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024 * 1024) {
        fail(new Error('实时策略检查点超过大小限制'));
        return;
      }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (++queued > 100) {
          fail(new Error('实时策略输出过快'));
          return;
        }
        pending = pending
          .then(async () => {
            if (signal.aborted || failed) return;
            lastMessage = Date.now();
            const message = JSON.parse(line);
            try {
              const value = await handle(message);
              signal.throwIfAborted();
              child.stdin.write(
                JSON.stringify({ id: message.id, value }) + '\n',
              );
            } catch (error) {
              child.stdin.write(
                JSON.stringify({
                  id: message.id,
                  error:
                    error instanceof Error ? error.message : '实时策略请求失败',
                }) + '\n',
              );
            } finally {
              lastMessage = Date.now();
              queued--;
            }
          })
          .catch(fail);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', fail);
    child.on('close', () => {
      for (const secret of secrets)
        if (secret) stderr = stderr.split(secret).join('[redacted]');
      clearInterval(watchdog);
      clearTimeout(escalation);
      signal.removeEventListener('abort', stop);
      kill('SIGKILL');
      void pending.finally(() => {
        if (signal.aborted) reject(new Error('用户中止了操作'));
        else
          reject(
            failed ??
              new Error(
                stderr.trim().split('\n').at(-1) || '实时策略进程已结束',
              ),
          );
      });
    });
  });
}
