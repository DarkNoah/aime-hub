"""Bounded server failover for the standard stock quote protocol."""
from common import emit

from ipaddress import IPv4Address
import re


def parse_servers(value):
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    if not 1 <= len(lines) <= 32:
        raise ValueError('Expected 1-32 IPv4:port entries')
    servers = []
    for line in lines:
        parts = line.split(':')
        if len(parts) != 2 or not re.fullmatch(r'[0-9]{1,5}', parts[1]):
            raise ValueError('Expected IPv4:port')
        host, port = str(IPv4Address(parts[0])), int(parts[1])
        if not 1 <= port <= 65535:
            raise ValueError('Invalid port')
        if not any(item[1:] == (host, port) for item in servers):
            servers.append((f'节点 {len(servers) + 1}', host, port))
    return servers


class TdxUnavailable(RuntimeError):
    pass


class TdxConnection:
    def __init__(self, config, api_factory=None):
        if api_factory is None:
            from pytdx.hq import TdxHq_API
            api_factory = TdxHq_API
        self.api_factory = api_factory
        self.servers = parse_servers(config['tdxServers'])
        self.api = None
        self.index = -1
        self._connect(set())

    @property
    def label(self):
        if self.api is None:
            return ''
        name, host, port = self.servers[self.index]
        return f'{name} {host}:{port}'

    def close(self):
        api, self.api = self.api, None
        if api is not None:
            try:
                api.disconnect()
            except Exception:
                pass
            finally:
                # PyTDX disconnect can raise before close when connect failed.
                client = getattr(api, 'client', None)
                if client is not None:
                    try:
                        client.close()
                    except Exception:
                        pass

    def _connect(self, failed):
        start = self.index + 1
        for offset in range(len(self.servers)):
            index = (start + offset) % len(self.servers)
            if index in failed:
                continue
            self.index = index
            name, host, port = self.servers[index]
            emit('status', state='starting', message=f'正在连接通达信：{name} {host}:{port}', active=0)
            try:
                # This class owns retries. Avoid retrying a dead node internally
                # or leaving a heartbeat thread behind when switching sockets.
                self.api = self.api_factory(heartbeat=False, auto_retry=False, raise_exception=True)
                if not self.api.connect(host, port, time_out=3):
                    raise TdxUnavailable()
                if not self.api.get_security_count(0):
                    raise TdxUnavailable()
                return
            except Exception:
                failed.add(index)
                self.close()
        raise TdxUnavailable('通达信服务器均不可用，稍后自动重试')

    def call(self, method, *args, allow_empty=True):
        failed = set()
        while len(failed) < len(self.servers):
            if self.api is None:
                self._connect(failed)
            try:
                result = getattr(self.api, method)(*args)
                if result is None or (not allow_empty and not result):
                    raise TdxUnavailable()
                return result
            except Exception:
                failed.add(self.index)
                self.close()
        raise TdxUnavailable('通达信服务器均不可用，稍后自动重试')
