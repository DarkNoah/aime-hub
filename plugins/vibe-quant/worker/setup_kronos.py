"""Explicit one-time download of an immutable offline Kronos bundle.

Run using the Python environment that has requirements-kronos.txt installed.
No credentials are required for these public upstream models.
"""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
import tempfile

SOURCE_REVISION = '67b630e67f6a18c9e9be918d9b4337c960db1e9a'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, default=Path(sys.prefix) / 'share/quant-kronos')
    parser.add_argument('--size', choices=['mini', 'small', 'base'], default='mini')
    args = parser.parse_args()
    target = args.target.resolve()
    if target.exists():
        parser.error('target already exists; use a new directory to keep bundles immutable')
    from huggingface_hub import HfApi, snapshot_download
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='kronos-setup-', dir=target.parent) as temporary:
        root = Path(temporary)
        subprocess.run(['git', 'clone', '--quiet', 'https://github.com/shiyu-coder/Kronos.git', str(root / 'source')], check=True)
        subprocess.run(['git', '-C', str(root / 'source'), 'checkout', '--quiet', SOURCE_REVISION], check=True)
        repositories = {'model': f'NeoQuasar/Kronos-{args.size}',
                        'tokenizer': f'NeoQuasar/Kronos-Tokenizer-{"2k" if args.size == "mini" else "base"}'}
        manifest = dict(source_revision=SOURCE_REVISION, size=args.size,
                        max_context=2048 if args.size == 'mini' else 512, repositories={}, files={})
        for name, repository in repositories.items():
            revision = HfApi().model_info(repository).sha
            snapshot_download(repository, revision=revision, local_dir=root / name,
                              allow_patterns=['config.json', 'model.safetensors'])
            manifest['repositories'][name] = dict(id=repository, revision=revision)
        for pattern in ('source/model/*.py', 'source/LICENSE', 'model/config.json', 'model/*.safetensors',
                        'tokenizer/config.json', 'tokenizer/*.safetensors'):
            for path in sorted(root.glob(pattern)):
                manifest['files'][path.relative_to(root).as_posix()] = sha256(path.read_bytes()).hexdigest()
        (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        # Atomic publication only after both snapshots and hashes are complete.
        root.rename(target)
    print(json.dumps({'bundle': str(target), 'size': args.size, 'repositories': manifest['repositories']}))


if __name__ == '__main__':
    main()
