"""Trusted snapshot preparation. Runs in the plugin venv before loading user code."""
import json
from datetime import datetime, timedelta
from pathlib import Path
import sys
from zoneinfo import ZoneInfo

if __name__ == '__main__':
    sys.path.insert(0, sys.argv[1])
from quant_sdk import Fees, HubClient, Instrument, TradingCalendar


def prepare(raw):
    config = raw['config']
    execution_model = config.get('execution_model', 'actual_contract')
    if execution_model not in ('actual_contract', 'continuous_price'):
        raise ValueError('Unknown execution model')
    proxy_symbol = config['symbol'] if execution_model == 'continuous_price' else None
    if proxy_symbol and (not proxy_symbol.startswith('KQ.m@') or raw['instruments'][proxy_symbol]['kind'] != 'continuous'):
        raise ValueError('Continuous-price simulation requires a main continuous series')
    supplied = config.get('calendar')
    if supplied is None:
        from chinese_calendar import is_holiday
        zone = ZoneInfo('Asia/Shanghai')
        day = datetime.fromtimestamp(config['start'], zone).date() - timedelta(days=2)
        last = datetime.fromtimestamp(config['end'], zone).date() + timedelta(days=32)
        supplied = {}
        while day <= last:
            # Never treat statutory make-up working weekends as exchange sessions.
            supplied[day.isoformat()] = day.weekday() < 5 and not is_holiday(day)
            day += timedelta(days=1)
    calendar = TradingCalendar(supplied)

    class FrozenClient(HubClient):
        def __init__(self):
            pass

        def instrument(self, symbol):
            metadata = raw['instruments'][symbol]
            # This frozen backtest alone treats the continuous series as a
            # synthetic future. Keep its real symbol and the raw catalog intact.
            return {**metadata, 'kind': 'future'} if symbol == proxy_symbol else metadata

        def history(self, symbol, duration, start, end):
            return (bar for bar in raw['bars'] if bar['symbol'] == symbol and bar['duration'] == duration and start <= bar['time'] < end)

        def contracts(self, symbol, start, end):
            return raw['mappings'][symbol]

    def rules(symbol, metadata):
        values = dict(config['rules'])
        values['fees'] = Fees(**values['fees'])
        if metadata['kind'] == 'stock':
            values['multiplier'] = values['margin_rate'] = 1
            if symbol.startswith(('SSE.000', 'SZSE.399')):
                values['tradable'] = False
        return Instrument(symbol, metadata['kind'], price_tick=metadata['priceTick'], **values)

    symbols = list(dict.fromkeys(filter(None, [config['symbol'], config['benchmark_symbol']])))
    data = FrozenClient().snapshot(symbols, start=config['start'], end=config['end'],
                                  duration=config['duration'], calendar=calendar, rules=rules)
    data.metadata.update(engine=raw['engine'], execution_model=execution_model,
                         calendar_source='explicit override' if config.get('calendar') is not None else 'chinese-calendar; weekends excluded')
    if proxy_symbol:
        data.metadata.update(data_policy='Latest-corrected stored-bar snapshot; simulated symbol skips actual-contract Tick reconstruction',
                             simulated_execution_symbol=proxy_symbol,
                             mapping_policy=f'{proxy_symbol}: continuous prices, no actual-contract mapping; other symbols retain observed mappings',
                             execution_policy='Synthetic continuous-price fills; excludes actual-contract basis and roll execution costs')
    return data


if __name__ == '__main__':
    raw = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    prepare(raw).save(sys.argv[3])
