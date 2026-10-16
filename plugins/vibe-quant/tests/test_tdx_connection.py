import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
from tdx_connection import TdxConnection, TdxUnavailable, parse_servers

SERVERS = [('one', '192.0.2.1', 7709), ('two', '192.0.2.2', 80), ('three', '192.0.2.3', 7709)]
CONFIG = {'tdxServers': '\n'.join(f'{host}:{port}' for _, host, port in SERVERS)}


class FailoverTests(unittest.TestCase):
    def setUp(self):
        self.events = patch('tdx_connection.emit').start()
        self.addCleanup(patch.stopall)
        self.attempts, self.closed, self.calls = [], [], []
        self.connect_failures, self.query_failures = set(), {}

    def factory(self, **options):
        self.assertFalse(options['auto_retry'])
        owner = self

        class Api:
            def connect(self, host, port, time_out):
                self.host = host
                owner.attempts.append((host, port))
                if host in owner.connect_failures:
                    raise TimeoutError()
                return self

            def get_security_count(self, market):
                return 100

            def get_security_quotes(self, pairs):
                owner.calls.append((self.host, pairs))
                result = owner.query_failures.get(self.host, [{'price': 12}])
                if isinstance(result, Exception):
                    raise result
                return result

            def get_security_bars(self, *args):
                return []

            def disconnect(self):
                owner.closed.append(self.host)

        return Api()

    def test_list_order_and_connect_failure_move_to_next_port(self):
        self.connect_failures.add('192.0.2.1')
        connection = TdxConnection(CONFIG, self.factory)
        self.addCleanup(connection.close)
        self.assertEqual(self.attempts, [('192.0.2.1', 7709), ('192.0.2.2', 80)])
        self.assertIn('192.0.2.2:80', connection.label)
        self.assertEqual(self.closed, ['192.0.2.1'])

    def test_first_entry_deduplicates_and_request_failure_retries_same_batch(self):
        connection = TdxConnection({'tdxServers': '192.0.2.2:80\n' + CONFIG['tdxServers']}, self.factory)
        self.addCleanup(connection.close)
        self.assertEqual(len(connection.servers), 3)
        self.query_failures['192.0.2.2'] = ConnectionError()
        pairs = [(1, '000852')]
        self.assertEqual(connection.call('get_security_quotes', pairs), [{'price': 12}])
        self.assertEqual(self.calls, [('192.0.2.2', pairs), ('192.0.2.1', pairs)])
        self.assertIn('192.0.2.2', self.closed)

    def test_none_and_empty_quotes_fail_over_but_empty_history_is_valid(self):
        connection = TdxConnection(CONFIG, self.factory)
        self.addCleanup(connection.close)
        self.query_failures.update({'192.0.2.1': None, '192.0.2.2': []})
        self.assertEqual(connection.call('get_security_quotes', [(1, '000852')], allow_empty=False), [{'price': 12}])
        self.assertEqual(connection.call('get_security_bars', 9, 1, '000852', 0, 1), [])
        self.assertEqual(len(self.attempts), 3)

    def test_all_nodes_down_is_bounded_and_closes_every_client(self):
        self.connect_failures.update(server[1] for server in SERVERS)
        with self.assertRaises(TdxUnavailable):
            TdxConnection(CONFIG, self.factory)
        self.assertEqual(len(self.attempts), 3)
        self.assertEqual(len(self.closed), 3)

    def test_server_list_rejects_malformed_addresses_and_preserves_order(self):
        self.assertEqual([item[1:] for item in parse_servers('192.0.2.2:80\n\n192.0.2.1:7709\r\n192.0.2.2:80')], [('192.0.2.2', 80), ('192.0.2.1', 7709)])
        for invalid in ['', 'example.com:7709', '256.1.1.1:7709', '192.0.2.1:0', '192.0.2.1:65536', '192.0.2.1:abc', '192.0.2.1:7709\n' * 33]:
            with self.assertRaises(ValueError):
                parse_servers(invalid)

    def test_all_requests_fail_once_per_node(self):
        connection = TdxConnection(CONFIG, self.factory)
        self.query_failures.update({server[1]: TimeoutError() for server in SERVERS})
        with self.assertRaises(TdxUnavailable):
            connection.call('get_security_quotes', [(1, '000852')])
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(self.attempts), 3)
        self.assertIsNone(connection.api)


if __name__ == '__main__':
    unittest.main()
