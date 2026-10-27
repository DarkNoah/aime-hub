from dataclasses import replace
"""Run existing Strategy callbacks against the public TqApi/TqSim interfaces."""
from datetime import date, datetime, time as daytime, timedelta
from math import isfinite
from pathlib import Path
import time
from zoneinfo import ZoneInfo

from .calendar import TradingCalendar
from .data import Dataset
from .models import Bar, Event, Fees, Instrument, Quote, RunConfig
from .runtime import Runner, _write
from .tq_broker import TqBroker
from .tq_metrics import performance

TZ = ZoneInfo('Asia/Shanghai')
DURATIONS = (60, 180, 300, 900, 1800, 3600, 86400)


def quote_time(quote):
    if not quote.datetime:
        return None
    return datetime.fromisoformat(quote.datetime).replace(tzinfo=TZ).timestamp()


class ReplayFeed:
    def __init__(self, api, runner, symbol, duration, calendar):
        self.api, self.runner, self.symbol = api, runner, symbol
        self.duration, self.calendar = duration, calendar
        self.serials, self.last_ids = {}, {}
        self.bars_seen = 0

    def subscribe(self):
        durations = {60, self.duration}
        for symbol, duration in self.runner.data._subscriptions:
            if symbol != self.symbol:
                raise ValueError('天勤回测首版仅支持所选的单个期货实际合约')
            if duration is not None:
                durations.add(duration)
        for duration in sorted(durations):
            if duration not in DURATIONS:
                raise ValueError(f'天勤回测不支持此 K 线周期：{duration}')
            if duration not in self.serials:
                self.serials[duration] = self.api.get_kline_serial(self.symbol, duration, data_length=2000)

    def events(self, now):
        events = []
        for duration, frame in self.serials.items():
            if frame.empty:
                continue
            previous = self.last_ids.get(duration, -1)
            latest = int(frame.iloc[-1]['id'])
            count = min(len(frame), max(0, latest - previous))
            if not count:
                continue
            for row in frame.iloc[-count:].to_dict('records'):
                if row['id'] < 0 or row['id'] <= previous or not row['datetime']:
                    continue
                start = int(row['datetime']) / 1e9
                if duration == 86400:
                    # TqSdk daily candles are anchored at the trading-date midnight
                    # and finalized at the next trading-day boundary (18:00).
                    day = datetime.fromtimestamp(start, TZ).date()
                    end = datetime.combine(day, daytime(18), TZ).timestamp() - 0.000001
                    trading_day = day.isoformat()
                else:
                    end = start + duration - 0.000001
                    trading_day = self.calendar.trading_day(start, futures=True)
                if end > now + 0.0000005:
                    continue  # Never deliver an unfinished candle to on_bar/history.
                values = [float(row[key]) for key in ('open', 'high', 'low', 'close', 'volume')]
                if not all(isfinite(v) for v in values):
                    continue
                self.last_ids[duration] = int(row['id'])
                self.bars_seen += 1
                bar = Bar(self.symbol, start, end, trading_day, duration, *values)
                warmup = end < self.runner.config.start or end <= getattr(self, 'discard_before', float('-inf')) or (previous == -1 and end < now - 0.000002)
                events.append((Event(f'tq:bar:{self.symbol}:{duration}:{int(row["datetime"])}',
                                     end if warmup and self.runner.data.now <= end else now, bar), warmup))
        return sorted(events, key=lambda item: (item[0].available_at, item[0].payload.end_time, item[0].payload.duration))


def prepare(strategy, api, sim, raw, *, output_dir, stop_event, sdk_version, on_event=None, restored=None, on_update=None):
    symbol = raw['symbol']
    live = raw.get('_live', False)
    config = RunConfig(**{key: raw[key] for key in ('start', 'end', 'initial_cash', 'slippage_ticks',
        'annualization', 'risk_free_rate', 'benchmark_symbol')}, participation_rate=1)
    quote = api.get_quote(symbol)
    if quote.ins_class != 'FUTURE':
        raise ValueError('天勤回测仅支持期货实际合约')
    options = raw.get('tq_options') or {}
    if options.get('commission_per_lot') is not None:
        sim.set_commission(symbol, options['commission_per_lot'])
    if options.get('margin_per_lot') is not None:
        sim.set_margin(symbol, options['margin_per_lot'])
    # This fetch uses the provider's exchange calendar, including holidays/night sessions.
    calendar_start = max(date(2003, 1, 1), datetime.fromtimestamp(config.start, TZ).date() - timedelta(days=3660))
    end_date = datetime.fromtimestamp(config.end, TZ).date()
    calendar_end = min(end_date + timedelta(days=40), date(datetime.now(TZ).year, 12, 31))
    calendar_frame = api.get_trading_calendar(calendar_start, calendar_end)
    days = {str(row['date'].date()): bool(row['trading']) for row in calendar_frame.to_dict('records')}
    calendar = TradingCalendar(days)
    commission, margin = sim.get_commission(symbol), sim.get_margin(symbol)
    for name, value in (('乘数', quote.volume_multiple), ('最小跳动', quote.price_tick), ('每手保证金', margin)):
        if not isfinite(value) or value <= 0:
            raise ValueError(f'天勤缺少有效的{name}；保证金可在回测设置中指定')
    if not isfinite(commission) or commission < 0:
        raise ValueError('天勤缺少每手手续费，请在回测设置中指定')
    initial_price = quote.last_price
    implied_margin = min(1, margin / (initial_price * quote.volume_multiple)) if isfinite(initial_price) and initial_price > 0 else 1
    instrument = Instrument(symbol, 'future', float(quote.price_tick), multiplier=float(quote.volume_multiple),
        margin_rate=implied_margin, lot_size=1, t_plus_one=False, fees=Fees(per_unit=float(commission), mode='fixed'))
    params = {**raw['parameters'], 'symbol': symbol, 'duration': raw['duration'], 'execution_model': 'actual_contract'}
    if restored:
        from .tq_restore import restore_runner
        runner = restore_runner(strategy, restored, output_dir, on_event)
        runner.config = replace(runner.config, end=config.end)
    else:
        runner = Runner(strategy, [instrument], params=params, config=config, output_dir=output_dir, on_event=on_event)
    runner.mode = 'paper' if live else 'backtest'
    runner.manifest['mode'] = runner.mode
    runner.stop_event = stop_event
    runner.broker = TqBroker(runner, api, sim, quote, calendar)
    runner.performance = lambda: performance(sim, quote)
    if restored:
        from .tq_restore import restore_broker
        restore_broker(runner, restored, api)
    runner.manifest.update(backtest_engine='tqsdk', tqsdk_version=sdk_version,
        execution_model='actual_contract', data_source='TqApi live quotes' if live else 'TqBacktest historical service',
        fill_model='TqSim opposite-quote aggressive limit; added slippage ticks; no partial fills',
        settlement_model='TqSim native settlement',
        risk_model={'trigger': 'observed quote last_price; stop_loss first',
                    'fill': 'TqSim order after trigger; no retroactive OHLC fills',
                    'precision': 'received live quotes' if live else 'K-line replay quotes, not historical ticks'},
        tq_rules={'commission_per_lot': float(commission), 'margin_per_lot': float(margin),
                  'multiplier': instrument.multiplier, 'price_tick': instrument.price_tick,
                  'overrides': options, 'source': 'explicit override or TqSim default; not historical fee schedules',
                  'instrument_margin_rate': 'initial implied ratio for strategy metadata only; account uses native margin'},
        strategy_scope='single actual futures contract; subscriptions on the same contract',
        replay_policy='closed candles and received quote events saved; not an offline TqSim re-execution')
    feed = ReplayFeed(api, runner, symbol, raw['duration'], calendar)
    last_quote, sequence = None, (restored or {}).get('sequence', 0)
    first_price = None
    active_bars = 0

    def consume(final=False):
        nonlocal last_quote, sequence, first_price, active_bars
        if stop_event.is_set():
            return
        now = quote_time(quote)
        if now is None or now > config.end or now < runner.data.now:
            return
        fresh = not live or time.time() - now < 15
        local_day = datetime.fromtimestamp(now, TZ).date()
        if local_day > max(calendar.days):
            extra = api.get_trading_calendar(max(calendar.days) + timedelta(days=1), date(local_day.year, 12, 31))
            calendar.days.update({row['date'].date(): bool(row['trading']) for row in extra.to_dict('records')})
        events = feed.events(now)
        for event, warmup in events:
            if warmup or not fresh:
                runner.process(event, warmup=True)
        if now < config.start:
            return
        day = calendar.trading_day(now, futures=True)
        sequence += 1
        runner.data.now = now
        ctx = runner.context
        ctx.event_id, ctx.trading_day, ctx.warming_up = f'tq:update:{sequence}', day, False
        runner.broker.sync()
        current = (quote.datetime, quote.last_price, quote.bid_price1, quote.ask_price1)
        changed = current != last_quote
        if changed and fresh:
            runner.broker.check_risk()
        curve_length = len(runner.curve)
        for event, warmup in events:
            if not warmup and fresh:
                active_bars += 1
                runner.process(event)
        if changed and fresh:
            valid = lambda value: float(value) if isfinite(value) else None
            runner.process(Event(f'tq:quote:{sequence}', now,
                Quote(symbol, now, day, valid(quote.last_price), valid(quote.bid_price1), valid(quote.ask_price1))))
            last_quote = current
        # A single account snapshot after all callbacks, including order-only updates.
        del runner.curve[curve_length:]
        if first_price is None and isfinite(quote.last_price) and quote.last_price > 0:
            first_price = quote.last_price
        point = {'time': now, 'trading_day': day, **runner.broker.account(),
                 'benchmark_equity': config.initial_cash * quote.last_price / first_price
                     if config.benchmark_symbol and first_price and isfinite(quote.last_price) else None}
        if runner.curve and runner.curve[-1]['time'] == now:
            runner.curve[-1] = point
        else:
            runner.curve.append(point)
        runner._deliver()
        if not final and fresh:
            runner.broker.advance()
        if on_update:
            on_update(runner, feed, sequence)
        return active_bars

    return runner, feed, consume


def run(strategy, api, sim, raw, *, output_dir, stop_event, finished_exception, sdk_version, redact=lambda value: value):
    runner, feed, consume = prepare(strategy, api, sim, raw, output_dir=output_dir, stop_event=stop_event, sdk_version=sdk_version)
    status, message = "succeeded", ""
    try:
        runner.start()
        feed.subscribe()
        consume()
        while not stop_event.is_set():
            feed.subscribe()
            api.wait_update(deadline=time.time() + 0.5)
            consume()
            if feed.bars_seen > 500_000 or runner.journal.tell() > 80 * 1024 * 1024:
                raise ValueError('天勤回测行情快照超过大小限制，请缩短区间')
    except finished_exception:
        # The final minute need not be followed by another candle to be exported.
        try:
            active_bars = consume(final=True)
            if not active_bars:
                status, message = 'failed', '所选区间没有已收盘的期货历史 K 线，请核对合约存续期与数据权限'
        except Exception as error:
            status, message = 'failed', redact(f'{type(error).__name__}: {error}')
    except Exception as error:
        status, message = 'failed', redact(f'{type(error).__name__}: {error}')
    if stop_event.is_set():
        status, message = 'cancelled', '用户中止了操作'
    result = runner.finish(status, message)
    result['backtest_engine'] = 'tqsdk'
    result['metric_notes']['execution'] = runner.manifest['fill_model']
    result['metric_notes']['risk'] = runner.manifest['risk_model']
    result['metric_notes']['fees'] = runner.manifest['tq_rules']
    # The same artifact shape drives the existing trade chart, open-trade reconstruction and export.
    dataset = Dataset.from_run(runner.directory)
    dataset.metadata.update(backtest_engine='tqsdk', engine='tqsdk', execution_model='actual_contract')
    dataset.save(Path(output_dir).parent / 'dataset.json')
    runner.manifest['data_snapshot_hash'] = dataset.fingerprint
    _write(runner.directory / 'manifest.json', runner.manifest)
    _write(runner.directory / 'result.json', result)
    return result
