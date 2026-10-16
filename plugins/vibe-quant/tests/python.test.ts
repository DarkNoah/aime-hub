import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePython } from '../server/python.js';
import { createPluginRuntime } from '../../../apps/server/src/modules/plugins/runtime.js';

test(
  'managed Python creates, reuses, upgrades and aborts incomplete environments',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'quant python '));
    const previousPath = process.env.PATH;
    const source = join(root, 'app/plugins/vibe-quant/worker');
    const bin = join(root, 'bin');
    await mkdir(source, { recursive: true });
    await mkdir(bin);
    const requirements = join(source, 'requirements.txt');
    await writeFile(requirements, 'fixture==1\n');
    const script = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(args[0]==='-m'&&args[1]==='venv'){
 const dir=args[2];fs.mkdirSync(path.join(dir,'bin'),{recursive:true});
 fs.copyFileSync(__filename,path.join(dir,'bin/python'));fs.chmodSync(path.join(dir,'bin/python'),0o700);
}else if(args[1]==='pip'){
 const dir=path.dirname(path.dirname(__filename));
 fs.appendFileSync(path.join(dir,'installs'),'install\\n');
 const req=fs.readFileSync(args[args.indexOf('-r')+1],'utf8');
 if(req.includes('slow'))setInterval(()=>{},1000);
}
`;
    await writeFile(join(bin, 'python3'), script, { mode: 0o700 });
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    const runtime = createPluginRuntime(
      { id: 'vibe-quant', workspace: true },
      {
        applicationRoot: join(root, 'app'),
        workspaceRoot: join(root, 'configured'),
      },
    );
    const signal = new AbortController().signal;
    try {
      const python = await ensurePython(runtime, signal);
      const venv = join(runtime.paths.pluginWorkspace!, '.venv');
      assert.equal(python, join(venv, 'bin/python'));
      assert.equal(await ensurePython(runtime, signal), python);
      assert.equal(await readFile(join(venv, 'installs'), 'utf8'), 'install\n');
      await writeFile(requirements, 'fixture==2\n');
      await ensurePython(runtime, signal);
      assert.equal(
        await readFile(join(venv, 'installs'), 'utf8'),
        'install\ninstall\n',
      );
      await rm(join(venv, '.requirements.sha256'));
      await writeFile(requirements, 'slow==1\n');
      await assert.rejects(ensurePython(runtime, AbortSignal.timeout(300)));
      await assert.rejects(access(join(venv, '.requirements.sha256')));
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);
