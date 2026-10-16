"""One read-only provider per process. The host owns persistence and retries."""
import json
import signal
import sys
from common import emit


def main():
    config = json.loads(sys.stdin.readline())
    # Keep stdout exclusively JSONL; SDK import/login messages belong on stderr.
    sys.stdout = sys.stderr
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        if config['engine'] == 'tqsdk':
            from tq_provider import run
        else:
            from polling import run
        run(config)
    except Exception as error:
        from tdx_connection import TdxUnavailable
        # Do not forward provider exceptions: authentication errors may contain secrets.
        reason = '缺少 Python 依赖' if isinstance(error, ImportError) else '候选行情服务器均不可用，30 秒后重试' if isinstance(error, TdxUnavailable) else '请检查账号权限、行情主机、交易日历与网络'
        emit('status', state='error', message=f"{config['engine']} 同步失败：{reason}", active=0)
        sys.exit(1)


if __name__ == '__main__':
    main()
