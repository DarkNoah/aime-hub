from datetime import datetime, timedelta
from common import TZ, DURATIONS, bar, emit, instrument, quote, timestamp
from tdx_connection import TdxConnection
from order_book import tdx_book

CATEGORIES = {60: 8, 300: 0, 900: 1, 1800: 2, 3600: 3, 86400: 9}


class Provider:
    def __init__(self, config):
        self.config = config
        self.connection = TdxConnection(config)
        self.last_bars = 0

    @property
    def connection_label(self):
        return self.connection.label

    def catalog(self):
        for market, exchange in ((0, 'SZSE'), (1, 'SSE')):
            count = self.connection.call('get_security_count', market, allow_empty=False)
            if not count:
                raise RuntimeError('TDX catalog unavailable')
            for offset in range(0, count, 1000):
                items = self.connection.call('get_security_list', market, offset, allow_empty=False)
                if items is None:
                    raise RuntimeError('TDX catalog unavailable')
                # Only A shares and exchange indices, no warrants/bonds masquerading as stocks.
                items = [item for item in items if (market == 1 and item['code'].startswith(('000', '600', '601', '603', '605', '688', '689')))
                         or (market == 0 and item['code'].startswith(('000', '001', '002', '003', '300', '301', '399')))]
                emit('catalog', instruments=[instrument(f"{exchange}.{item['code']}", item['name']) for item in items])

    def calendar(self, day):
        from chinese_calendar import is_holiday
        # Library raises when a year's official holiday schedule is unknown. Fail closed.
        return {(day + timedelta(days=i)).isoformat(): (day + timedelta(days=i)).weekday() < 5
                and not is_holiday(day + timedelta(days=i)) for i in (-1, 0, 1)}

    def poll(self, symbols, first):
        import time
        pairs = [(1 if symbol.startswith('SSE.') else 0, symbol.split('.')[1]) for symbol in symbols]
        received = []
        for offset in range(0, len(pairs), 80):
            rows = self.connection.call('get_security_quotes', pairs[offset:offset + 80], allow_empty=False)
            if rows is None:
                raise RuntimeError('TDX quotes unavailable')
            received_at = time.time()
            books = []
            for row in rows:
                symbol = f"{'SSE' if row['market'] else 'SZSE'}.{row['code']}"
                if not self.is_index(symbol):
                    books.append(tdx_book(symbol, row, received_at))
            if books:
                # Persist depth even if the following historical-bar request fails.
                emit('data', quotes=[], bars=[], orderBooks=books)
            for row in rows:
                symbol = f"{'SSE' if row['market'] else 'SZSE'}.{row['code']}"
                # The standard quote protocol provides no reliable full date. Use the
                # latest daily bar's date, and report that precision instead of inventing a tick time.
                daily = self.connection.call('get_index_bars' if self.is_index(symbol) else 'get_security_bars', 9, row['market'], row['code'], 0, 1)
                if not daily:
                    continue
                when = timestamp(str(daily[-1]['datetime'])[:10])
                row = {**row, 'vol': row['vol'] * 100}
                value = quote(symbol, when, row, {'last': 'price', 'preClose': 'last_close', 'volume': 'vol', 'bid': 'bid1', 'ask': 'ask1'})
                if value:
                    received.append(value)
        emit('data', quotes=received, bars=[])
        if not first and time.monotonic() - self.last_bars < 15:
            return
        for symbol, (market, code) in zip(symbols, pairs):
            method = 'get_index_bars' if self.is_index(symbol) else 'get_security_bars'
            for duration in DURATIONS:
                count = min(self.config['historyBars'], 8000) if first else 2
                for offset in range(0, count, 800):
                    rows = self.connection.call(method, CATEGORIES[duration], market, code, offset, min(800, count - offset))
                    if rows is None:
                        raise RuntimeError('TDX bars unavailable')
                    output = []
                    for row in rows:
                        when = timestamp(row['datetime'])
                        if when and duration < 86400:
                            when -= duration  # TDX timestamps label bar end; chart labels bar start.
                        if when and duration == 86400:
                            when = datetime.fromtimestamp(when, TZ).replace(hour=0, minute=0, second=0).timestamp()
                        value = bar(symbol, duration, when, {**row, 'vol': row['vol'] * 100}, 'vol')
                        if value:
                            output.append(value)
                    emit('data', quotes=[], bars=output)
                    if len(rows) < min(800, count - offset):
                        break
        self.last_bars = time.monotonic()

    @staticmethod
    def is_index(symbol):
        return symbol.startswith(('SSE.000', 'SZSE.399'))

    def close(self):
        self.connection.close()
