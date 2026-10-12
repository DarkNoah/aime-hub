#!/usr/bin/env python3
"""Trigger Dokploy from a private server when the configured Git branch changes."""
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.request


def main():
    config = json.loads(Path('/etc/hub-git-deploy/config.json').read_text())
    branch = config['branch']
    output = subprocess.check_output(
        ['git', 'ls-remote', '--exit-code', config['repository'], f'refs/heads/{branch}'],
        text=True, timeout=45,
        env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
    )
    commit = output.split()[0]
    state = Path('/var/lib/hub-git-deploy/last-requested')
    if state.exists() and state.read_text().strip() == commit:
        return
    payload = json.dumps({
        'ref': f'refs/heads/{branch}', 'after': commit,
        'head_commit': {'id': commit, 'message': f'Git auto deploy {commit[:12]}'},
        'commits': [{'id': commit, 'message': f'Git auto deploy {commit[:12]}',
                     'added': [], 'modified': [], 'removed': []}],
    }).encode()
    request = urllib.request.Request(
        config['webhook_url'], data=payload,
        headers={'Content-Type': 'application/json', 'X-GitHub-Event': 'push'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f'Dokploy returned HTTP {response.status}')
    except urllib.error.HTTPError as error:
        # The webhook URL contains a secret; do not include it in logs.
        raise RuntimeError(f'Dokploy returned HTTP {error.code}') from None
    except urllib.error.URLError:
        raise RuntimeError('Dokploy webhook could not be reached') from None
    state.parent.mkdir(parents=True, exist_ok=True)
    temporary = state.with_suffix('.tmp')
    temporary.write_text(commit + '\n')
    temporary.replace(state)
    print(f'Queued Dokploy deployment for {commit[:12]}')


if __name__ == '__main__':
    main()
