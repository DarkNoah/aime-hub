"""Numerical, causal, and universe contract tests for all 810 built-in formulas."""
from dataclasses import replace
from datetime import date, timedelta
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk'))
from quant_sdk import Bar
from quant_sdk.alpha import ExpressionFactor
from quant_sdk.alpha.engine import PanelEngine
from quant_sdk.alpha.parser import parse, inspect
import numpy as np
import pandas as pd

CATALOG = json.loads((ROOT/'server/factors/builtins/formulas.json').read_text())


def factor(family, key):
    row = next(r for r in CATALOG if r['family'] == family and r['key'] == key)
    return type('TestAlpha', (ExpressionFactor,), {'family': family, 'expression': row['expression']})()


def panel(length=520):
    rng = np.random.default_rng(191)
    close = pd.DataFrame(100 + np.cumsum(rng.normal(0, .5, (length, 4)), axis=0))
    groups = pd.DataFrame([['a', 'a', 'b', 'b']]*length)
    return dict(close=close, open=close+rng.normal(0, .2, close.shape), high=close+1, low=close-1,
                volume=pd.DataFrame(rng.uniform(100, 1000, close.shape)), amount=close*1000,
                vwap=close*.999, cap=close*100000, sector=groups, industry=groups, subindustry=groups,
                benchmark_close=close*.9, benchmark_open=close*.9-.1,
                mkt=close.pct_change(fill_method=None), smb=pd.DataFrame(rng.normal(0, .01, close.shape)),
                hml=pd.DataFrame(rng.normal(0, .01, close.shape)))


def histories(length=65, count=4):
    fields = panel(length)
    result = {}
    for s in range(count):
        symbol = f'SHFE.test{s}'
        result[symbol] = [Bar(symbol=symbol, time=i*86400, end_time=(i+1)*86400,
                             trading_day=(date(2020,1,1)+timedelta(days=i)).isoformat(), duration=86400,
                             **{name: float(fields[name].iloc[i,s]) for name in ('open','close','high','low','volume','amount','vwap')})
                          for i in range(length)]
    return result


class AlphaLibraryTest(unittest.TestCase):
    def test_complete_catalog_every_formula_executes_and_metadata_matches(self):
        counts = {name: sum(r['family'] == name for r in CATALOG) for name in ('worldquant101','gtja191','qlib158','qlib360')}
        self.assertEqual(counts, dict(worldquant101=101, gtja191=191, qlib158=158, qlib360=360))
        fields = panel()
        for row in CATALOG:
            with self.subTest(family=row['family'], key=row['key']):
                info = inspect(parse(row['expression']), row['family'])
                for key, value in info.items(): self.assertEqual(row[key], value)
                self.assertTrue(1 <= info['lookback'] <= 500)
                values = PanelEngine(fields, row['family']).evaluate(row['expression'])
                self.assertEqual(values.shape, (520,4))
                self.assertFalse(np.isinf(values.values).any())

    def test_qlib_and_wq_values_match_independent_arithmetic(self):
        h = histories()
        one = next(iter(h.values()))
        for key, expected in [('KMID',(one[-1].close-one[-1].open)/one[-1].open),
                              ('MA5',np.mean([b.close for b in one[-5:]])/one[-1].close),
                              ('ROC5',one[-6].close/one[-1].close),
                              ('STD5',np.std([b.close for b in one[-5:]],ddof=1)/one[-1].close),
                              ('IMAX5',(np.argmax([b.high for b in one[-5:]])+1)/5)]:
            self.assertAlmostEqual(factor('qlib158',key).evaluate(one),expected)
        self.assertAlmostEqual(factor('qlib360','CLOSE59').evaluate(one), one[-60].close/one[-1].close)
        self.assertAlmostEqual(factor('qlib360','VOLUME0').evaluate(one),one[-1].volume/(one[-1].volume+1e-12))
        self.assertAlmostEqual(factor('worldquant101','ALPHA101').evaluate(one),(one[-1].close-one[-1].open)/(one[-1].high-one[-1].low+.001))
        self.assertAlmostEqual(factor('gtja191','ALPHA014').evaluate(one),one[-1].close-one[-6].close)

    def test_rank_is_cross_section_and_adv_is_dollar_volume(self):
        data = pd.DataFrame([[3.,1.,2.],[8.,4.,4.]])
        engine = PanelEngine({'close':data,'volume':data*10,'amount':data*1000},'worldquant101')
        np.testing.assert_allclose(engine.evaluate('rank(close)').values, [[1,1/3,2/3],[1,.5,.5]])
        np.testing.assert_allclose(engine.evaluate('adv2').iloc[-1], [5500,2500,3000])
        with self.assertRaisesRegex(ValueError,'横截面'):
            factor('worldquant101','ALPHA003').evaluate(next(iter(histories().values())))

    def test_future_changes_cannot_change_past_values(self):
        for family,key in [('worldquant101','ALPHA002'),('worldquant101','ALPHA003'),('gtja191','ALPHA014'),('qlib158','BETA5')]:
            f = factor(family,key)
            full = histories(65)
            partial = {s:b[:40] for s,b in full.items()}
            actual = f.evaluate_panel(full)
            expected = f.evaluate_panel(partial)
            pd.testing.assert_frame_equal(actual.iloc[:40],expected)

    def test_missing_vwap_is_error_not_hlc_proxy(self):
        h = {s:[replace(b,vwap=None) for b in bars] for s,bars in histories().items()}
        with self.assertRaisesRegex(ValueError,'vwap'):
            factor('qlib360','VWAP0').evaluate_panel(h)
        with self.assertRaisesRegex(ValueError,'cap'):
            factor('worldquant101','ALPHA056').evaluate_panel(h)
        with self.assertRaisesRegex(ValueError,'日线'):
            factor('qlib158','KMID').evaluate([replace(next(iter(h.values()))[-1], duration=3600)])

    def test_fixed_universe_does_not_rank_survivors(self):
        h = histories(65)
        symbol = list(h)[0]
        missing = h[symbol][30].trading_day
        h[symbol].pop(30)
        f = factor('worldquant101','ALPHA033')
        values = f.evaluate_panel(h)
        self.assertTrue(values.loc[missing].isna().all())

    def test_recursive_and_ordinary_panel_match_scalar_windows(self):
        for family,key,n in [('gtja191','ALPHA081',502),('qlib158','ROC5',65),('worldquant101','ALPHA101',65)]:
            f = factor(family,key)
            h = histories(n,1)
            bars = next(iter(h.values()))
            result = f.evaluate_panel(h)
            self.assertAlmostEqual(result.iloc[-1,0],f.evaluate(bars),places=12)
            self.assertAlmostEqual(result.iloc[-2,0],f.evaluate(bars[:-1]),places=12)

    def test_operator_conventions(self):
        x = pd.DataFrame({'a':[1.,2.,3.,4.,5.]})
        e = PanelEngine({'close':x},'gtja191')
        self.assertAlmostEqual(e.evaluate('WMA(close,3)').iloc[-1,0],np.dot([3,4,5],[.81,.9,1])/2.71)
        self.assertAlmostEqual(e.evaluate('SMA(close,3,1)').iloc[-1,0],1*(2/3)**4+sum(v*(1/3)*(2/3)**(4-i) for i,v in enumerate([1,2,3,4,5]) if i>0))
        self.assertAlmostEqual(e.evaluate('REGBETA(close,SEQUENCE(3))').iloc[-1,0],1)
        self.assertAlmostEqual(e.evaluate('DECAYLINEAR(close,3)').iloc[-1,0],(3+8+15)/6)
        self.assertAlmostEqual(e.evaluate('HIGHDAY(close,3)').iloc[-1,0],0)
        self.assertTrue(e.evaluate('close/0').isna().all().all())
        with self.assertRaises(ValueError):parse('__import__("os")')
        with self.assertRaises(ValueError):e.evaluate('delay(close,-1)')


if __name__ == '__main__':unittest.main()
