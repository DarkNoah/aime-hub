"""Validate the entry point in the same restricted process environment as strategies."""
import json
from pathlib import Path
import sys

sys.path.insert(0, sys.argv[1])
from quant_sdk.factors import factor_from_source

raw = json.loads((Path(sys.argv[2]) / 'input.json').read_text(encoding='utf-8'))
factor = factor_from_source(raw['source'])
count = factor.lookback(raw['parameters'])
if type(count) is not int or not 1 <= count <= 500:
    raise ValueError('因子 lookback 必须是 1 至 500 的整数')
