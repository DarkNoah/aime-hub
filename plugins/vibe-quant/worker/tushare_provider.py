import json
import time
from datetime import datetime, timedelta
from urllib.request import Request, urlopen
from common import TZ, DURATIONS, bar, emit, instrument, quote, timestamp
from order_book import tushare_book


class Provider:
    def __init__(self, config):
        self.config = config
        self.indices = set()
        self.calendar_day = None
        self.calendar_data = {}
        self.last_bars = 0

    def request(self, api, fields='', **params):
        request = Request('https://api.tushare.pro', data=json.dumps({
            'api_name': api, 'token': self.config['tushareToken'], 'params': params, 'fields': fields,
        }).encode(), headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=15) as response:
            result = json.load(response)
        if result.get('code') != 0:
            raise RuntimeError('Tushare request failed')
        data = result['data']
        return [dict(zip(data['fields'], row)) for row in data['items']]

    @staticmethod
    def canonical(code):
        ticker, market = code.split('.')
        return f"{'SSE' if market == 'SH' else 'SZSE'}.{ticker}"

    @staticmethod
    def native(symbol):
        market, ticker = symbol.split('.')
        return f"{ticker}.{'SH' if market == 'SSE' else 'SZ'}"

    def catalog(self):
        records = {}
        for row in self.request('stock_basic', fields='ts_code,name', list_status='L'):
            if row['ts_code'].endswith(('.SH', '.SZ')):
                symbol = self.canonical(row['ts_code'])
                records[symbol] = instrument(symbol, row['name'])
        for market in ('SSE', 'SZSE', 'CSI'):
            for row in self.request('index_basic', fields='ts_code,name', market=market):
                if row['ts_code'].endswith(('.SH', '.SZ')):
                    symbol = self.canonical(row['ts_code'])
                    self.indices.add(symbol)
                    records[symbol] = instrument(symbol, row['name'])
        values = list(records.values())
        for offset in range(0, len(values), 500):
            emit('catalog', instruments=values[offset:offset + 500])

    def calendar(self, day):
        if self.calendar_day != day:
            rows = self.request('trade_cal', exchange='SSE', start_date=(day - timedelta(days=10)).strftime('%Y%m%d'), end_date=(day + timedelta(days=15)).strftime('%Y%m%d'))
            self.calendar_data = {datetime.strptime(row['cal_date'], '%Y%m%d').date().isoformat(): bool(row['is_open']) for row in rows}
            if day.isoformat() not in self.calendar_data:
                raise RuntimeError('Calendar unavailable')
            self.calendar_day = day
        return self.calendar_data

    def poll(self, symbols, first):
        for is_index in (False, True):
            group = [symbol for symbol in symbols if (symbol in self.indices) == is_index]
            for offset in range(0, len(group), 50):
                selected = group[offset:offset + 50]
                codes = ','.join(self.native(symbol) for symbol in selected)
                if not codes:
                    continue
                fields = 'ts_code,trade_time,close,pre_close,open,high,low,vol,amount'
                if not is_index:
                    fields += ',bid_price1,bid_volume1,ask_price1,ask_volume1'
                rows = self.request('rt_idx_k' if is_index else 'rt_k', ts_code=codes, fields=fields)
                received_at = time.time()
                quotes, bars, books = [], [], []
                for row in rows:
                    symbol = self.canonical(row['ts_code'])
                    when = timestamp(row.get('trade_time'))
                    if not is_index:
                        books.append(tushare_book(symbol, row, when, received_at))
                    value = quote(symbol, when, row, {'last': 'close', 'preClose': 'pre_close', 'volume': 'vol',
                                                    'bid': 'bid_price1', 'ask': 'ask_price1'})
                    if value:
                        quotes.append(value)
                        start = datetime.fromtimestamp(when, TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
                        daily = bar(symbol, 86400, start, row, 'vol')
                        if daily:
                            bars.append(daily)
                emit('data', quotes=quotes, bars=bars, orderBooks=books)
                if first or time.monotonic() - self.last_bars >= 60:
                    for duration in DURATIONS[:-1]:
                        rows = self.request('rt_idx_min' if is_index else 'rt_min', ts_code=codes, freq=f'{duration // 60}MIN')
                        bars = []
                        for row in rows:
                            when = timestamp(row['time'])
                            value = bar(self.canonical(row['ts_code']), duration, when - duration if when else None, row, 'vol')
                            if value:
                                bars.append(value)
                        emit('data', quotes=[], bars=bars)
        if first:
            for symbol in symbols:
                is_index = symbol in self.indices
                rows = self.request('index_daily' if is_index else 'daily', ts_code=self.native(symbol), limit=self.config['historyBars'])
                bars = []
                for row in rows:
                    when = datetime.strptime(row['trade_date'], '%Y%m%d').replace(tzinfo=TZ).timestamp()
                    # Historical daily APIs use lots and thousand yuan; real-time uses shares and yuan.
                    row = {**row, 'vol': float(row['vol']) * 100}
                    value = bar(symbol, 86400, when, row, 'vol', amount_scale=1000)
                    if value:
                        bars.append(value)
                emit('data', quotes=[], bars=bars)
        if first or time.monotonic() - self.last_bars >= 60:
            self.last_bars = time.monotonic()

    def close(self):
        pass
