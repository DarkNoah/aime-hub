import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ffmpegPath } from '../audio/binaries.js';

test('conversion removes source, WAV and temporary directory after success, failure and in-flight cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'conversion-cleanup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const wav = Buffer.alloc(46);
  wav.write('RIFF');
  wav.writeUInt32LE(38, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2, 40);
  const wavPath = join(root, 'sample.wav');
  await writeFile(wavPath, wav);
  await writeFile(
    join(bin, 'ffmpeg'),
    `#!${process.execPath}
const fs = require('node:fs');
const destination = process.argv.at(-1);
fs.copyFileSync(process.env.TEST_WAV, destination);
fs.writeFileSync(process.env.TEST_MARKER, 'started');
if (process.env.TEST_MODE === 'cancel') setInterval(() => {}, 1000);
else process.exit(process.env.TEST_MODE === 'failure' ? 1 : 0);
`,
    { mode: 0o755 },
  );
  for (const mode of ['success', 'failure', 'cancel']) {
    await t.test(mode, async () => {
      const scratch = join(root, mode);
      const marker = join(root, `${mode}.started`);
      await mkdir(scratch);
      const script = `
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const execFile = childProcess.execFile;
childProcess.execFile = (command, ...args) => {
  assert.equal(command, ${JSON.stringify(ffmpegPath)});
  return execFile(process.env.TEST_CONVERTER, ...args);
};
syncBuiltinESMExports();
const { normalizeTranscriptionAudio } = await import(${JSON.stringify(new URL('../audio/convert.ts', import.meta.url).href)});
process.env.TMPDIR = process.env.TEST_SCRATCH;
process.env.TMP = process.env.TEST_SCRATCH;
process.env.TEMP = process.env.TEST_SCRATCH;
const data = Buffer.alloc(12); data.write('ftyp', 4);
const controller = new AbortController();
const operation = normalizeTranscriptionAudio(data, controller.signal);
const checked = process.env.TEST_MODE === 'success' ? operation : assert.rejects(operation);
if (process.env.TEST_MODE === 'cancel') {
  const deadline = Date.now() + 5000;
  while (true) {
    try { await access(process.env.TEST_MARKER); break; }
    catch { if (Date.now() > deadline) throw new Error('Converter did not start'); }
    await setTimeout(10);
  }
  controller.abort();
}
await checked;
`;
      await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          env: {
            ...process.env,
            TEST_CONVERTER: join(bin, 'ffmpeg'),
            TEST_SCRATCH: scratch,
            TEST_MODE: mode,
            TEST_WAV: wavPath,
            TEST_MARKER: marker,
          },
          timeout: 15000,
        },
      );
      assert.deepEqual(await readdir(scratch), []);
    });
  }
});
