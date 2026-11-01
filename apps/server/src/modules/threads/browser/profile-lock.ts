import { readlink, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';

const singletonFiles = ['SingletonSocket', 'SingletonCookie', 'SingletonLock'];

async function linkTarget(path: string) {
  try {
    return await readlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors do not prove that the owner is gone.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function socketIsActive(path: string) {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ path });
    const finish = (active: boolean) => {
      socket.destroy();
      resolve(active);
    };
    socket.once('connect', () => finish(true));
    // An unresponsive owner may still be using the profile; leave its lock alone.
    socket.setTimeout(1000, () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
        resolve(false);
      else reject(error);
    });
  });
}

/**
 * Profiles belong to this single API instance (see docs/deployment.md), never
 * to multiple replicas or hosts. Docker replaces the hostname on recreation,
 * but retains these symlinks in the workspace volume after an unclean exit.
 * Chromium cannot reclaim a different hostname's lock by itself.
 */
export async function recoverBrowserProfileLock(profile: string) {
  const lockPath = join(profile, 'SingletonLock');
  const lock = await linkTarget(lockPath);
  if (lock === null) return;
  const owner = /^(.*)-(\d+)$/.exec(lock);
  const pid = Number(owner?.[2]);
  const busy = () => new Error('浏览器配置目录仍被占用，无法安全启动浏览器');
  if (!owner?.[1] || !Number.isSafeInteger(pid) || pid <= 0) throw busy();
  if (owner[1] === hostname() && processExists(pid)) throw busy();
  if (await socketIsActive(join(profile, 'SingletonSocket'))) throw busy();

  // Snapshot all links and recheck before deleting. Never follow a link or
  // delete profile data, and release the lock last so Chromium cannot acquire
  // it while its old socket/cookie links are still being removed.
  const targets = await Promise.all(
    singletonFiles.map((name) => linkTarget(join(profile, name))),
  );
  if (targets[2] !== lock) throw busy();
  for (const [index, name] of singletonFiles.entries()) {
    const path = join(profile, name);
    if ((await linkTarget(lockPath)) !== lock) throw busy();
    if ((await linkTarget(path)) !== targets[index]) throw busy();
    if (targets[index] !== null) await unlink(path);
  }
}
