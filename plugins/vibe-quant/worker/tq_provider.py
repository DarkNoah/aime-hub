import time
from datetime import datetime, timedelta
from common import TZ, DURATIONS, bar, emit, in_session, instrument, quote, timestamp
from order_book import tq_book

KINDS = {'STOCK': 'stock', 'FUND': 'stock', 'INDEX': 'stock', 'FUTURE': 'future', 'OPTION': 'option', 'CONT': 'continuous'}


def load_catalog(api):
    symbols = list(api.query_quotes(ins_class=list(KINDS), expired=False))
    for offset in range(0, len(symbols), 300):
        records = []
        for row in api.query_symbol_info(symbols[offset:offset + 300]).to_dict('records'):
            symbol = row['instrument_id']
            kind = KINDS.get(row['ins_class'])
            if not kind:
                continue
            if row['ins_class'] == 'INDEX' and not symbol.startswith(('SSE.', 'SZSE.')):
                # Commodity weighted indices are not exchange stock indices.
                kind = 'continuous'
            records.append(instrument(symbol, row['instrument_name'], kind, row.get('product_id', ''),
                                      row.get('price_tick'), row.get('underlying_symbol', ''), row.get('expired', False)))
        emit('catalog', instruments=records)
    emit('catalog_complete')


def run(config):
    from tqsdk import TqApi, TqAuth
    # No broker account or order API is constructed or exposed by this plugin.
    api = TqApi(auth=TqAuth(config['tqUser'], config['tqPassword']))
    try:
        load_catalog(api)
        symbols = config['symbols']
        quotes = api.get_quote_list(symbols) if symbols else []
        serials = {(symbol, duration): api.get_kline_serial(symbol, duration, data_length=config['historyBars'])
                   for symbol in symbols for duration in DURATIONS}
        initialized = set()
        calendar = {}
        calendar_day = None
        last_status = 0
        while True:
            now = datetime.now(TZ)
            if calendar_day != now.date():
                frame = api.get_trading_calendar(now.date() - timedelta(days=10), now.date() + timedelta(days=15))
                calendar = {str(row['date'].date()): bool(row['trading']) for row in frame.to_dict('records')}
                calendar_day = now.date()
            api.wait_update(deadline=time.time() + 1)
            received_at = time.time()
            changed_quotes, changed_bars, books = [], [], []
            active = set()
            for symbol, item in zip(symbols, quotes):
                sessions = {'day': item.trading_time.day, 'night': item.trading_time.night}
                if in_session(now, sessions, calendar, config['beforeOpenMinutes'], config['afterCloseMinutes']):
                    active.add(symbol)
                if api.is_changing(item) and (symbol in active or (symbol, 'quote') not in initialized):
                    source_time = timestamp(item.datetime)
                    value = quote(symbol, source_time, item, {
                        'last': 'last_price', 'preClose': 'pre_close', 'openInterest': 'open_interest',
                        'bid': 'bid_price1', 'ask': 'ask_price1'}, item.underlying_symbol)
                    if source_time is not None and item.ins_class != 'INDEX':
                        books.append(tq_book(symbol, item, source_time, received_at))
                        initialized.add((symbol, 'quote'))
                    if value:
                        changed_quotes.append(value)
                        initialized.add((symbol, 'quote'))
            for (symbol, duration), frame in serials.items():
                key = (symbol, duration)
                if not api.is_serial_ready(frame):
                    continue
                first = key not in initialized
                if not first and (symbol not in active or not api.is_changing(frame)):
                    continue
                rows = frame if first else frame.tail(2)
                for row in rows.to_dict('records'):
                    value = bar(symbol, duration, row['datetime'] / 1e9, row)
                    if value:
                        changed_bars.append(value)
                initialized.add(key)
            # Bound JSONL records so the host can apply stream backpressure.
            for offset in range(0, len(changed_bars), 2000):
                emit('data', quotes=[], bars=changed_bars[offset:offset + 2000])
            if changed_quotes or books:
                emit('data', quotes=changed_quotes, bars=[], orderBooks=books)
            if time.monotonic() - last_status > 2:
                state = 'syncing' if active else 'closed' if symbols else 'idle'
                emit('status', state=state, message='实时订阅已连接' if active else '休市，等待下个同步窗口' if symbols else '添加自选后自动订阅', active=len(active))
                last_status = time.monotonic()
    finally:
        api.close()
