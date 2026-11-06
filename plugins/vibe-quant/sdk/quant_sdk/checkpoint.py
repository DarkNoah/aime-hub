"""Checkpoint compatibility is a versioned contract, separate from code identity.

Bump CHECKPOINT_VERSION when state layout or execution semantics make old state
unsafe to resume. Compatible releases retain it; runtime_hash remains an audit
fingerprint. Never infer compatibility for an unknown unversioned runtime.
"""

SDK_VERSION = '0.1.1'
CHECKPOINT_VERSION = 1

# Reviewed deployed SDKs before checkpoint_version was introduced. The only
# difference between these builds adds net_pnl to native closing-fill output;
# it changes neither persisted account/state layout nor execution decisions.
LEGACY_CHECKPOINT_VERSIONS = {
    '91acc1838741c0d91ba3c29603785d8109d176d44a0d444a124eff4d6eeaef10': 1,
    '3c845ac9662916a3a6bba569faa7df3b309d5aa038cf6bce5873d1bdabcc886d': 1,
}


def validate_checkpoint_runtime(manifest, runtime_hash):
    if 'checkpoint_version' in manifest:
        version = manifest['checkpoint_version']
    elif manifest.get('runtime_hash') == runtime_hash:
        version = CHECKPOINT_VERSION
    else:
        version = LEGACY_CHECKPOINT_VERSIONS.get(manifest.get('runtime_hash'))
    if type(version) is not int or version != CHECKPOINT_VERSION:
        raise ValueError(
            'SDK checkpoint version is incompatible; '
            '检查点与当前 SDK 不兼容，需要迁移或重新计算，原检查点已保留'
        )
