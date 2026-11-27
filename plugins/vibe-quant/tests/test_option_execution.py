from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'sdk'), str(ROOT / 'worker')]
from quant_sdk import OptionExecution, RiskLevels, RunConfig, Strategy, backtest
from quant_sdk.options import CASH_INDEX
from strategy_prepare import prepare

START = 1792373400


class Targets(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], 60)

    def on_bar(self, ctx, bar):
        actual = ctx.data.resolve_contract(bar.symbol)
        ctx.log('observed', position=ctx.position(actual))
        n = int((bar.time - START) / 60)
        quantity = ctx.params['targets'].get(str(n))
        if quantity is not None:
            entry = ctx.orders.target_position(actual, quantity)
            if quantity and ctx.params.get('source_stop'):
                return RiskLevels(actual, entry_id=entry, stop_loss=4900, stop_loss_pnl=9999)


def fixture(product='IM', *, main=False, right='C', volumes=(20, 20, 20, 20, 20)):
    actual = f'CFFEX.{product}2611'
    family = {'IM': 'MO', 'IF': 'IO'}.get(product)
    source = f'KQ.m@CFFEX.{product}' if main else actual
    ticker = f'CFFEX.{family}2611-{right}-5000'
    instruments, bars = {}, []
    def series(symbol, kind, prices, size):
        instruments[symbol] = dict(symbol=symbol, kind=kind, priceTick=.2)
        for n, (price, volume) in enumerate(zip(prices, size)):
            bars.append(dict(symbol=symbol, time=START + 60*n, duration=60, open=price, high=price+1,
                             low=price-1, close=price, volume=volume))
    series(actual, 'future', [5066 if not family else 5000]*5, [60]*5)
    if main:
        series(source, 'continuous', [5100]*5, [60]*5)
    if family:
        series(CASH_INDEX[family], 'stock', [5066 if right == 'C' else 4934]*5, [300]*5)
        series(ticker, 'option', [100, 100, 112, 112, 113], volumes)
        series(ticker.replace('5000','4995' if right == 'C' else '5005'), 'option', [100]*5, [10]*5)
    return dict(engine='tqsdk', instruments=instruments, bars=bars,
                mappings={source: [dict(time=START, underlying=actual)]} if main else {},
                config=dict(symbol=source, benchmark_symbol=None, duration=60, start=START, end=START+5*60,
                            option_execution={'mode':'time_value_third'}, calendar={'2026-10-19':True},
                            rules=dict(multiplier=200, margin_rate=.1, fees=dict(per_unit=2)))), ticker


class OptionExecutionTest(unittest.TestCase):
    def execute(self, raw, targets=None, **params):
        config = raw['config']
        dataset = prepare(raw)
        with tempfile.TemporaryDirectory() as directory:
            result = backtest.run(Targets(), dataset, params=dict(symbol=config['symbol'],
                                  targets=targets or {'0': 3}, **params),
                                  config=RunConfig(initial_cash=25000, participation_rate=.1,
                                  option_execution=OptionExecution(**config['option_execution'])),
                                  output_dir=directory)
        self.assertEqual(result['status'], 'succeeded', result['message'])
        return result

    def test_cumulative_volume_only_breaks_a_share_tie(self):
        raw, first = fixture(volumes=(1000,) * 5)
        second = first.replace('5000', '4934')
        raw['instruments'][second] = dict(symbol=second, kind='option', priceTick=.2)
        raw['bars'] += [dict(b, symbol=second, open=200, close=200, high=201, low=199, volume=15)
                        for b in raw['bars'] if b['symbol'] == first]
        raw['option_volume_prefix'] = [
            dict(symbol=first, stamp=START-60, lots=500),
            dict(symbol=second, stamp=START-60, lots=980),
            dict(symbol=second, stamp=START-86400, lots=10000),
        ]
        decision = self.execute(raw)['signals'][0]
        self.assertEqual((decision['symbol'], decision['volume'], decision['day_volume']), (second, 15, 995))
        raw['option_volume_prefix'][1]['lots'] = 2200
        self.assertEqual(self.execute(raw)['signals'][0]['symbol'], first)
        for bar in raw['bars']:
            if bar['symbol'] == second:
                bar.update(open=198, close=198, high=199, low=197)
        self.assertEqual(self.execute(raw)['signals'][0]['symbol'], second)

    def test_expiry_week_uses_premium_only_after_both_ranks_tie(self):
        raw, first = fixture()
        second = first.replace('5000', '4934')
        # The lower strike sorts first. Outside expiry week it wins even when
        # its premium is farther from 200.
        for row in raw['bars']:
            if row['symbol'] == CASH_INDEX['MO']:
                row.update(open=5132, close=5132, high=5133, low=5131)
            if row['symbol'] == first:
                row.update(open=200, close=200, high=201, low=199)
        raw['instruments'][second] = dict(symbol=second, kind='option', priceTick=.2)
        raw['bars'] += [dict(b, symbol=second, open=300, close=300, high=301, low=299)
                        for b in raw['bars'] if b['symbol'] == first]
        for expiry, selected in [('2026-10-30', second), ('2026-10-23', first), ('2026-10-19', first)]:
            for s in (first, second):
                raw['instruments'][s]['expiryDay'] = expiry
            self.assertEqual(self.execute(raw)['signals'][0]['symbol'], selected)

    def test_missing_spot_skips_and_no_percentage_band_is_applied(self):
        raw, _ = fixture()
        spot = CASH_INDEX['MO']
        for row in raw['bars']:
            if row['symbol'] == spot:
                row.update(open=4800, close=4800, high=4801, low=4799)
        self.assertEqual(self.execute(raw)['signals'][0]['time_value_ratio'], 1)
        raw['bars'] = [b for b in raw['bars'] if b['symbol'] != spot or b['time'] > START]
        self.assertEqual(self.execute(raw)['signals'][0]['kind'], 'option_entry_skipped')

    def test_old_serialized_settings_migrate_and_unknown_mode_fails(self):
        self.assertEqual(RunConfig(option_execution={'profile':'balanced', 'target_leverage':20}).option_execution,
                         OptionExecution())
        with self.assertRaises(ValueError):
            RunConfig(option_execution={'mode':'unknown'})

    def test_automatic_mapping_premium_trigger_and_cash(self):
        for product, right, target, main in [('IM','C',3,True), ('IF','P',-2,False)]:
            raw, ticker = fixture(product, main=main, right=right)
            raw['config']['option_execution']['take_profit_pct'] = 10
            result = self.execute(raw, {'0':target})
            trade, = result['trades']
            self.assertEqual((trade['symbol'], trade['quantity'], trade['exit_reason']), (ticker, 1, 'take_profit'))
            self.assertAlmostEqual(trade['trigger_price'], 110)
            self.assertEqual((trade['entry_price'],trade['exit_price'],trade['net_pnl']), (100,112,1196))
            self.assertEqual(result['account']['cash'], 26196)
            self.assertEqual(result['equity_curve'][-1]['equity'], 26196)
            self.assertTrue(any(x.get('position') == (1 if target > 0 else -1) for x in result['logs']))
            decision = next(x for x in result['signals'] if x['kind'] == 'target_position')
            self.assertAlmostEqual(decision['time_value_ratio'], .34)
            self.assertEqual(decision['reference_symbol'], CASH_INDEX['MO' if product == 'IM' else 'IO'])

    def test_insufficient_volume_at_selection_or_execution_skips_this_signal(self):
        for volumes in [(9,30,30,30,30), (20,9,30,30,30)]:
            raw, ticker = fixture(volumes=volumes)
            raw['bars'] = [bar for bar in raw['bars'] if bar['symbol'] != ticker.replace('5000','4995')]
            result = self.execute(raw)
            self.assertEqual(result['fills'], [])
            if volumes[0] == 9:
                self.assertEqual(result['signals'][0]['kind'],'option_entry_skipped')
            else:
                self.assertEqual(result['orders'][0]['reason'],'OPTION_ENTRY_NO_LIQUIDITY')

    def test_optional_premium_exits_are_strategy_parameters(self):
        raw, ticker = fixture()
        self.assertEqual(self.execute(raw)['trades'], [])
        trade, = self.execute(raw, option_take_profit_pct=10)['trades']
        self.assertEqual((trade['symbol'], trade['net_pnl']), (ticker, 1196))
        raw['config']['option_execution']['take_profit_pct'] = 10
        self.assertEqual(self.execute(raw, option_take_profit_pct=None)['trades'], [])
        raw['bars'] = [{**bar, 'low': 88} if bar['symbol'] == ticker and bar['time'] == START + 60
                       else bar for bar in raw['bars']]
        trade, = self.execute(raw, option_take_profit_pct=None, option_stop_loss_pct=10)['trades']
        self.assertEqual((trade['exit_reason'], trade['exit_price']), ('stop_loss', 90))

    def test_existing_signal_stop_closes_bound_option_at_its_market_price(self):
        raw, ticker = fixture()
        raw['bars'][2]['low'] = 4850
        result = self.execute(raw, source_stop=True)
        self.assertEqual(result['trades'][0]['symbol'], ticker)
        self.assertEqual(result['trades'][0]['net_pnl'], 1196)

    def test_bracket_protects_opening_bar_and_stop_wins_ambiguous_range(self):
        raw, ticker = fixture()
        raw['config']['option_execution'].update(stop_loss_pct=10, take_profit_pct=10)
        entry_bar = next(b for b in raw['bars'] if b['symbol'] == ticker and b['time'] == START + 60)
        entry_bar.update(high=115, low=85)
        result = self.execute(raw)
        trade, = result['trades']
        self.assertEqual((trade['exit_reason'], trade['exit_price'], trade['net_pnl']), ('stop_loss', 90, -1004))

    def test_flattening_after_roll_closes_original_option(self):
        raw, ticker = fixture(main=True)
        main = raw['config']['symbol']
        old, new = 'CFFEX.IM2611', 'CFFEX.IM2612'
        raw['instruments'][new] = {**raw['instruments'][old], 'symbol': new}
        raw['bars'] += [{**b, 'symbol': new} for b in raw['bars'] if b['symbol'] == old]
        raw['mappings'][main].append(dict(time=START+3*60, underlying=new))
        result = self.execute(raw, {'0': 1, '2': 0})
        self.assertEqual([fill['symbol'] for fill in result['fills']], [ticker, ticker])

    def test_reversal_waits_for_close_before_buying_put(self):
        raw, call = fixture()
        put = call.replace('-C-5000', '-P-5140')
        raw['instruments'][put] = {**raw['instruments'][call], 'symbol':put}
        raw['bars'] += [{**b, 'symbol':put} for b in raw['bars'] if b['symbol'] == call]
        result = self.execute(raw, {'0':1,'1':-1})
        self.assertEqual([(f['symbol'],f['quantity']) for f in result['fills']], [(call,1),(call,-1),(put,1)])
        self.assertEqual(result['account']['positions'], {put:1})

    def test_stale_minute_and_unobserved_chain_never_open_future(self):
        raw, ticker = fixture()
        raw['bars'] = [b for b in raw['bars'] if not b['symbol'].startswith('CFFEX.MO') or b['time'] == START]
        result = self.execute(raw, {'1':1})
        self.assertEqual(result['fills'], [])
        self.assertEqual(result['signals'][0]['kind'], 'option_entry_skipped')

    def test_catalog_links_other_option_products_and_uses_their_multiplier(self):
        raw, _ = fixture('XX')
        source = raw['config']['symbol']
        option = 'TEST.XOPT-5000'
        raw['instruments'][option] = dict(symbol=option, kind='option', priceTick=.2,
            underlying=source, optionRight='C', strike=5000, volumeMultiple=10)
        raw['bars'] += [{**b, 'symbol':option, 'open':100, 'close':100, 'low':99, 'high':101}
                        for b in raw['bars'] if b['symbol'] == source]
        result = self.execute(raw)
        self.assertEqual(result['fills'][0]['symbol'],option)
        self.assertEqual(result['account']['available'],25000-100*10-2)
        self.assertEqual(result['account']['margin'],0)

    def test_selects_liquid_alternative_to_dry_nearest_strike(self):
        raw, ticker = fixture(volumes=(0, 20, 20, 20, 20))
        self.assertEqual(self.execute(raw)['fills'][0]['symbol'],ticker.replace('5000','4995'))

    def test_unrelated_future_keeps_original_size_and_pnl(self):
        raw, _ = fixture('XX')
        result = self.execute(raw, {'0': 2, '2':0})
        self.assertEqual(result['fills'], [])  # original futures margin exceeds 25,000
        self.assertEqual(result['orders'][0]['symbol'], 'CFFEX.XX2611')
        self.assertEqual(result['orders'][0]['target'], 2)
