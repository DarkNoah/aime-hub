"""Automatically select the script's unique concrete Strategy subclass."""
import inspect


def resolve_strategy(module, base):
    candidates = set(
        value for value in vars(module).values()
        if inspect.isclass(value) and value is not base
        and value.__module__ == module.__name__
        and issubclass(value, base) and not inspect.isabstract(value)
    )
    # A local reusable base and its concrete derived strategy are one entry.
    leaves = [cls for cls in candidates
              if not any(other is not cls and issubclass(other, cls) for other in candidates)]
    if len(leaves) == 1:
        return leaves[0]
    if not leaves:
        raise ValueError('未找到可实例化的 quant_sdk.Strategy 子类')
    names = ', '.join(sorted(cls.__name__ for cls in leaves))
    raise ValueError(f'发现多个独立的 Strategy 子类：{names}。请将不同策略拆分为单独脚本，每个脚本保留一个具体策略类')
