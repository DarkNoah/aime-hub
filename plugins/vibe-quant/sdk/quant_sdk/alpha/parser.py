"""Small, non-executing parser for the published alpha expression languages."""
import re
from functools import lru_cache

TOKEN = re.compile(r'(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z_][a-z_0-9.]*|==|!=|<=|>=|&&|\|\||[-+*/^<>=?:(),&|]')
PRIORITY = {'||': 1, '|': 1, '&&': 2, '&': 2, '=': 3, '==': 3, '!=': 3,
            '<': 3, '>': 3, '<=': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '^': 7}
ALIASES = {'corr': 'correlation', 'coviance': 'covariance', 'std': 'stddev',
           'tsrank': 'ts_rank', 'tsmin': 'ts_min', 'tsmax': 'ts_max',
           'decaylinear': 'decay_linear', 'prod': 'product', 'ma': 'mean',
           'ref': 'delay', 'idxmax': 'ts_argmax', 'idxmin': 'ts_argmin',
           'ret': 'returns', 'vol': 'volume', 'banchmarkindexclose': 'benchmark_close',
           'banchmarkindexopen': 'benchmark_open'}
DERIVED = {
    'returns': 'close/delay(close,1)-1',
    'hd': 'high-delay(high,1)', 'ld': 'delay(low,1)-low',
    'tr': 'greater(greater(high-low,abs(high-delay(close,1))),abs(low-delay(close,1)))',
    'dtm': 'open<=delay(open,1)?0:greater(high-open,open-delay(open,1))',
    'dbm': 'open>=delay(open,1)?0:greater(open-low,open-delay(open,1))',
}


@lru_cache(maxsize=2048)
def parse(expression):
    text = re.sub(r'\s+', '', expression.lower().replace('$', ''))
    tokens = TOKEN.findall(text)
    if ''.join(tokens) != text:
        raise ValueError('公式包含不支持的字符')
    pos = 0

    def take(value=None):
        nonlocal pos
        if pos >= len(tokens) or (value is not None and tokens[pos] != value):
            raise ValueError(f'公式语法错误，位置 {pos}，预期 {value}')
        result = tokens[pos]
        pos += 1
        return result

    def expr(minimum=0):
        token = take()
        if token in ('+', '-'):
            left = ('unary', token, expr(6))
        elif token == '(':
            left = expr()
            take(')')
        elif re.fullmatch(r'(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?', token):
            left = ('number', float(token))
        elif re.fullmatch(r'[a-z_][a-z_0-9.]*', token):
            name = ALIASES.get(token, token)
            if pos < len(tokens) and tokens[pos] == '(':
                take('(')
                args = []
                if pos < len(tokens) and tokens[pos] != ')':
                    while True:
                        args.append(expr())
                        if pos >= len(tokens) or tokens[pos] != ',':
                            break
                        take(',')
                take(')')
                left = ('call', name, tuple(args))
            elif name in DERIVED:
                left = parse(DERIVED[name])
            elif re.fullmatch(r'adv\d+', name):
                # The WorldQuant paper defines ADV as daily dollar volume.
                left = ('call', 'mean', (('field', 'amount'), ('number', float(name[3:]))))
            else:
                left = ('field', name.removeprefix('indclass.'))
        else:
            raise ValueError(f'公式语法错误：{token}')
        while pos < len(tokens):
            op = tokens[pos]
            if op == '?' and minimum == 0:
                take('?')
                yes = expr()
                take(':')
                left = ('call', 'where', (left, yes, expr()))
            elif op in PRIORITY and PRIORITY[op] >= minimum:
                take()
                level = PRIORITY[op]
                left = ('binary', op, left, expr(level if op == '^' else level + 1))
            else:
                break
        return left

    tree = expr()
    if pos != len(tokens):
        raise ValueError(f'公式有多余内容：{"".join(tokens[pos:])}')
    return tree


def inspect(tree, family):
    """Return input fields, finite history bound and cross-sectional requirement."""
    fields, functions = set(), set()

    def visit(node):
        kind, name, *rest = node
        if kind == 'number':
            return 1
        if kind == 'field':
            fields.add(name)
            return 1
        if kind == 'unary':
            return visit(rest[0])
        if kind == 'binary':
            return max(visit(n) for n in rest)
        functions.add(name)
        args = rest[0]
        length = max((visit(a) for a in args), default=1)
        if name == 'delay' or name == 'delta':
            return length + int(args[1][1] if len(args) > 1 else 1)
        if name == 'sequence':
            return int(args[0][1])
        if name == 'regbeta' and args[1][0] == 'call' and args[1][1] == 'sequence':
            return visit(args[0]) + int(args[1][2][0][1]) - 1
        if name in ('correlation', 'covariance', 'regbeta', 'regresi'):
            return length + int(args[-1][1]) - 1 if args[-1][0] == 'number' else length
        if name in ('mean', 'sum', 'stddev', 'ts_rank', 'ts_min', 'ts_max', 'ts_argmax', 'ts_argmin',
                    'decay_linear', 'product', 'wma', 'count', 'sumif', 'highday', 'lowday',
                    'slope', 'rsquare', 'resi', 'quantile', 'rsrange') or (
                        name in ('min', 'max', 'rank') and len(args) == 2 and args[1][0] == 'number' and args[1][1] > 0):
            return length + int(args[1][1]) - 1
        return length

    lookback = visit(tree)
    cross = bool(functions & {'scale', 'indneutralize'}) or ('rank' in functions and not family.startswith('qlib'))
    recursive = bool(functions & {'sma', 'selfalpha'})
    return dict(fields=sorted(fields), lookback=500 if recursive else lookback,
                cross_sectional=cross, recursive=recursive)
