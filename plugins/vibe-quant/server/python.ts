import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PluginRuntimeContext } from '@app/plugin-sdk/server';

const execute = promisify(execFile);
const probe =
  'import sys; assert sys.version_info >= (3, 10); import tqsdk, pytdx, chinese_calendar, optuna';
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Collectors and strategy jobs share one venv; serialize repairs across local processes. */
export async function ensurePython(
  runtime: PluginRuntimeContext,
  signal: AbortSignal,
): Promise<string> {
  const directory = await runtime.ensureWorkspace();
  const lock = join(directory, '.python-setup.lock');
  while (true) {
    signal.throwIfAborted();
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 20 * 60_000)
        await rm(lock, { recursive: true, force: true });
      else await delay(200, undefined, { signal });
    }
  }
  try {
    return await prepare(runtime, directory, signal);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function prepare(
  runtime: PluginRuntimeContext,
  directory: string,
  signal: AbortSignal,
) {
  const environment = join(directory, '.venv');
  const python = join(
    environment,
    runtime.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const requirements = join(
    runtime.paths.pluginRoot,
    'worker/requirements.txt',
  );
  const fingerprint = createHash('sha256')
    .update(await readFile(requirements))
    .update(`managed-venv-v1:${runtime.platform}:${runtime.arch}`)
    .digest('hex');
  const marker = join(environment, '.requirements.sha256');
  const run = (file: string, args: string[], timeout = 600_000) =>
    execute(file, args, {
      signal,
      timeout,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
    });
  try {
    if ((await readFile(marker, 'utf8').catch(() => '')) === fingerprint) {
      try {
        await run(python, ['-c', probe], 90_000);
        return python;
      } catch {
        signal.throwIfAborted();
        // Repair an interrupted or obsolete environment using the host interpreter.
      }
    }
    await run(
      runtime.platform === 'win32' ? 'python' : 'python3',
      ['-m', 'venv', environment],
      120_000,
    );
    const wheels = join('/opt/plugin-wheels', 'vibe-quant');
    const offline = await exists(wheels);
    await run(python, [
      '-m',
      'pip',
      'install',
      '--quiet',
      '--no-input',
      ...(offline ? ['--no-index', '--find-links', wheels] : []),
      '-r',
      requirements,
    ]);
    await run(python, ['-c', probe], 90_000);
    signal.throwIfAborted();
    await writeFile(marker, fingerprint, { mode: 0o600 });
    return python;
  } catch {
    signal.throwIfAborted();
    throw new Error(
      'Python 环境准备失败，请检查宿主 Python 3.10+、venv 及依赖下载网络',
    );
  }
}
