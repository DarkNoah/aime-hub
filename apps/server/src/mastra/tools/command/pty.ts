import type { LocalSandbox } from '@mastra/core/workspace';
import type { IPty } from 'node-pty';

export interface CommandHandle {
  pid: string;
  done: Promise<number>;
  write(chars: string): Promise<void>;
  kill(): Promise<unknown>;
  release(): void;
}

/** Keep PTY execution under the same environment and isolation as pipe commands. */
export async function spawnPty(
  sandbox: LocalSandbox,
  shell: string,
  args: string[],
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  output: (data: string) => void,
): Promise<CommandHandle> {
  const { spawn } = await import('node-pty');
  const invocation =
    sandbox.isolation === 'none'
      ? { command: shell, args }
      : sandbox.wrapCommandForIsolation(command);
  const env = Object.fromEntries(
    Object.entries(sandbox.buildEnv(environment)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const terminal: IPty = spawn(invocation.command, invocation.args, {
    cwd,
    env,
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
  });
  let exited = false;
  const dataListener = terminal.onData(output);
  const done = new Promise<number>((resolve) => {
    const exitListener = terminal.onExit(({ exitCode, signal }) => {
      exited = true;
      dataListener.dispose();
      exitListener.dispose();
      resolve(signal ? 128 + signal : exitCode);
    });
  });
  return {
    pid: String(terminal.pid),
    done,
    async write(chars) {
      if (exited) throw new Error('Command session has already exited');
      terminal.write(chars);
    },
    async kill() {
      if (exited) return;
      // PTYs start a session/process group; also terminate child commands.
      try {
        process.kill(-terminal.pid, 'SIGKILL');
      } catch {
        terminal.kill('SIGKILL');
      }
      await done;
    },
    release() {},
  };
}
