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
    if execution_model not in ('actual_contract', 'continuous_price', 'points'):
        raise ValueError('Unknown execution model')
    points = execution_model == 'points'
    proxy_symbol = config['symbol'] if execution_model in ('continuous_price', 'points') else None
    if execution_model == 'continuous_price' and (not proxy_symbol.startswith('KQ.m@') or raw['instruments'][proxy_symbol]['kind'] != 'continuous'):
        raise ValueError('Continuous-price simulation requires a main continuous series')
    bars = [bar for bar in raw['bars'] if config['start'] <= bar['time'] < config['end']]
    if not bars:
        raise ValueError('所选回测区间内没有可用行情，请调整日期或先采集/导入数据')
    supplied = config.get('calendar')
    if supplied is None:
        from chinese_calendar import is_holiday
        zone = ZoneInfo('Asia/Shanghai')
        observations = {(bar['time'], raw['instruments'][bar['symbol']]['kind'] != 'stock') for bar in bars}
        for symbol, mappings in raw['mappings'].items():
            if symbol != proxy_symbol:
                observations.update((max(config['start'], row['time']), True) for row in mappings
                                    if row['time'] < config['end'])
        supplied = {}
        # Only observed bars/mappings need calendar dates. Empty portions of a
        # requested window may extend beyond published holiday calendars.
        for timestamp, futures in sorted(observations):
            local = datetime.fromtimestamp(timestamp, zone)
            day = local.date() + timedelta(days=1 if futures and local.hour >= 18 else 0)
            overnight = futures and (local.hour >= 18 or local.hour < 6)
            for _ in range(32 if overnight else 1):
                key = day.isoformat()
                if key not in supplied:
                    # Never treat statutory make-up weekends as exchange sessions.
                    supplied[key] = day.weekday() < 5 and not is_holiday(day)
                if supplied[key]:
                    break
                day += timedelta(days=1)
    calendar = TradingCalendar(supplied)

    class FrozenClient(HubClient):
        def __init__(self):
            pass

        def instrument(self, symbol):
            metadata = raw['instruments'][symbol]
            # Synthetic execution exists only in this frozen historical snapshot.
            # The live catalog and ordinary index order checks remain unchanged.
            return {**metadata, 'kind': 'future'} if symbol == proxy_symbol else metadata

        def rules(self, symbol, resolver):
            if points and symbol == proxy_symbol:
                return resolver(symbol, self.instrument(symbol))
            return super().rules(symbol, resolver)

        def history(self, symbol, duration, start, end):
            return (bar for bar in bars if bar['symbol'] == symbol and bar['duration'] == duration and start <= bar['time'] < end)

        def contracts(self, symbol, start, end):
            return raw['mappings'][symbol]

    def rules(symbol, metadata):
        if points and symbol == proxy_symbol:
            return Instrument(symbol, 'future', price_tick=metadata['priceTick'],
                              multiplier=1, margin_rate=1, lot_size=1, t_plus_one=False)
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
    if raw.get('derived_bars'):
        data.metadata['derived_bars'] = raw['derived_bars']
        data.metadata['signal_bar_policy'] = 'Five-minute signals use five consecutive closed minute bars when available, sharing the execution price series; stored five-minute bars are fallback; snapshot only'
    if proxy_symbol:
        data.metadata.update(data_policy='Latest-corrected stored-bar snapshot; simulated symbol skips actual-contract Tick reconstruction',
                             simulated_execution_symbol=proxy_symbol,
                             mapping_policy=f'{proxy_symbol}: continuous prices, no actual-contract mapping; other symbols retain observed mappings',
                             execution_policy='Synthetic continuous-price fills; excludes actual-contract basis and roll execution costs')
    if points:
        data.metadata.update(pnl_unit='points',
                             mapping_policy=f'{proxy_symbol}: direct price-point simulation without contract mapping',
                             execution_policy='Fixed one unit per direction; price differences net of point costs and slippage; no capital, multiplier, margin, volume or T+1 constraints')
    return data


if __name__ == '__main__':
    raw = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    prepare(raw).save(sys.argv[3])
