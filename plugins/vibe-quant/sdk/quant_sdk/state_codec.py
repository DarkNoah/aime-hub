"""Versioned checkpoint state encoding; dates survive restore with their types."""
from datetime import date, datetime


def encode_state(value):
    if isinstance(value, datetime):
        return ['datetime', value.isoformat(), value.fold]
    if isinstance(value, date):
        return ['date', value.isoformat()]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise TypeError('Strategy state dictionary keys must be strings')
        return ['dict', [[key, encode_state(item)] for key, item in value.items()]]
    if isinstance(value, (list, tuple)):
        return ['list', [encode_state(item) for item in value]]
    if value is None or isinstance(value, (str, bool, int, float)):
        return ['value', value]
    raise TypeError(f'Unsupported strategy state type: {type(value).__name__}')


def decode_state(node):
    kind, value = node[:2]
    if kind == 'datetime':
        return datetime.fromisoformat(value).replace(fold=node[2])
    if kind == 'date':
        return date.fromisoformat(value)
    if kind == 'dict':
        return {key: decode_state(item) for key, item in value}
    if kind == 'list':
        return [decode_state(item) for item in value]
    if kind == 'value':
        return value
    raise ValueError('Unsupported checkpoint state encoding')
