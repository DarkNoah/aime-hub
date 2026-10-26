"""Optuna search over a frozen backtest snapshot; each trial runs in a fresh process."""
import json
import math
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import optuna
from optuna.trial import TrialState

MAX_RESULT_BYTES = 128 * 1024 * 1024


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    temporary.replace(path)


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RESULT_BYTES:
        raise ValueError('回测产物无效或超过 128 MiB')
    return json.loads(path.read_text(encoding='utf-8'))


def evaluate(root, sdk, config, name, stop, timeout):
    """Bound each child, including import/on_start hangs. Do not retain losing artifacts."""
    directory = root / name
    directory.mkdir()
    try:
        for filename in ('strategy.py', 'dataset.json'):
            # Hard links avoid multiplying a large frozen snapshot per trial (same filesystem).
            (directory / filename).hardlink_to(root / filename)
        write_json(directory / 'config.json', config)
        child = subprocess.Popen(
            [sys.executable, '-B', '-u', str(Path(__file__).with_name('strategy_run.py')), sdk, str(directory)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + timeout
        try:
            while child.poll() is None:
                if stop.wait(0.05):
                    raise InterruptedError('用户中止了操作')
                if time.monotonic() >= deadline:
                    raise TimeoutError('单次试验超时或搜索时间已耗尽')
            if stop.is_set():
                raise InterruptedError('用户中止了操作')
            if child.returncode:
                raise RuntimeError('策略进程执行失败，请检查源码及入口')
            result = read_json(directory / 'result.json')
            run_id = result.get('run_id', '')
            if len(run_id) != 32 or any(c not in '0123456789abcdef' for c in run_id):
                raise ValueError('SDK 返回了无效运行 ID')
            manifest = read_json(directory / 'artifacts' / run_id / 'manifest.json')
            return result, manifest
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def optimize(root, sdk, stop):
    raw = read_json(root / 'config.json')
    options = raw.pop('optimization')
    metric = options['metric']
    direction = 'minimize' if metric == 'max_drawdown' else 'maximize'
    split = options.get('validation_start')
    training = {**raw, 'end': split - 1 if split is not None else raw['end']}
    report = {
        'engine': 'optuna', 'optuna_version': optuna.__version__, 'sampler': 'TPESampler',
        'seed': options['seed'], 'metric': metric, 'direction': direction,
        'status': 'running', 'message': '正在准备调参', 'requested_trials': options['n_trials'],
        'completed_trials': 0, 'best_trial': None, 'best_run_id': None, 'best_value': None, 'best_parameters': None,
        'training': {'start': training['start'], 'end': training['end']},
        'validation': ({'start': split, 'end': raw['end'], 'status': 'pending',
                        'message': '等待训练选参完成', 'metrics': {}} if split is not None else None),
        'trials': [],
    }

    def checkpoint(message=None):
        if message is not None:
            report['message'] = message
        write_json(root / 'optimization.json', report)

    checkpoint()
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction=direction, sampler=optuna.samplers.TPESampler(seed=options['seed']))
    deadline = time.monotonic() + options['timeout_seconds']
    timed_out = False
    try:
        for index in range(options['n_trials']):
            if stop.is_set():
                raise InterruptedError('用户中止了操作')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            trial = study.ask()
            params = dict(raw['parameters'])
            row = {'number': trial.number, 'state': 'failed', 'parameters': {}, 'value': None, 'metrics': {}, 'message': ''}
            checkpoint(f'Optuna 调参 {index + 1}/{options["n_trials"]}，已完成 {len(report["trials"])} 次')
            try:
                for key, space in options['search_space'].items():
                    if space['type'] == 'categorical':
                        params[key] = trial.suggest_categorical(key, space['choices'])
                    else:
                        suggest = trial.suggest_int if space['type'] == 'int' else trial.suggest_float
                        kwargs = {'log': space.get('log', False)}
                        if 'step' in space:
                            kwargs['step'] = space['step']
                        params[key] = suggest(key, space['low'], space['high'], **kwargs)
                row['parameters'] = dict(trial.params)
                result, manifest = evaluate(root, sdk, {**training, 'parameters': params}, f'trial-{index}', stop, min(300, remaining))
                row['metrics'] = result['metrics']
                if result['status'] != 'succeeded':
                    raise RuntimeError(result['message'] or '策略回测失败')
                value = result['metrics'].get(metric)
                if not result['equity_curve'] or len(result['trades']) < options['min_trades']:
                    raise optuna.TrialPruned('交易数量不足，不参与最优参数选择')
                if not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise optuna.TrialPruned('目标指标未定义，不参与最优参数选择')
                study.tell(trial, value)
                row.update(state='complete', value=value)
                report['completed_trials'] += 1
                best = report['best_value']
                if best is None or (value < best if direction == 'minimize' else value > best):
                    # Keep the actual winning run, not a stochastic rerun of its parameters.
                    artifacts = root / 'artifacts'
                    artifacts.mkdir(exist_ok=True)
                    destination = artifacts / result['run_id']
                    destination.mkdir(exist_ok=True)
                    write_json(destination / 'manifest.json', manifest)
                    write_json(destination / 'result.json', result)
                    # Publish only a fully saved pair; the parent uses this ID even if killed
                    # during the convenience result.json update or old-artifact cleanup.
                    report.update(best_trial=trial.number, best_run_id=result['run_id'], best_value=value, best_parameters=params)
            except optuna.TrialPruned as error:
                row.update(state='pruned', message=str(error))
                study.tell(trial, state=TrialState.PRUNED)
            except InterruptedError:
                row.update(state='cancelled', message='用户中止了操作')
                study.tell(trial, state=TrialState.FAIL)
                raise
            except Exception as error:
                row['message'] = str(error)[:1000]
                # A persistence failure after tell must fail the job instead of telling twice.
                if row['state'] == 'complete':
                    raise
                study.tell(trial, state=TrialState.FAIL)
            finally:
                report['trials'].append(row)
                checkpoint()
                if report['best_run_id'] is not None:
                    best_directory = root / 'artifacts' / report['best_run_id']
                    alias = root / 'result.tmp'
                    alias.unlink(missing_ok=True)
                    alias.hardlink_to(best_directory / 'result.json')
                    alias.replace(root / 'result.json')
                    for previous in (root / 'artifacts').iterdir():
                        if previous != best_directory:
                            shutil.rmtree(previous)
        timed_out = timed_out or (time.monotonic() >= deadline and len(report['trials']) < options['n_trials'])
        if report['best_trial'] is None:
            report['status'] = 'failed'
            checkpoint('没有满足交易数量和目标指标要求的试验，请检查试验记录、范围及数据区间')
            return report
        if split is not None:
            checkpoint('搜索结束，正在用最佳参数评估留出验证区间')
            validation = report['validation']
            try:
                result, manifest = evaluate(root, sdk, {**raw, 'start': split, 'parameters': report['best_parameters']}, 'validation', stop, 300)
                validation.update(status=result['status'], message=result['message'], metrics=result['metrics'])
                if result['status'] == 'succeeded' and not result['equity_curve']:
                    validation.update(status='failed', message='验证区间没有可评估的行情')
                write_json(root / 'validation.json', {'result': result, 'manifest': manifest})
            except InterruptedError:
                validation.update(status='cancelled', message='用户中止了操作')
                raise
            except Exception as error:
                validation.update(status='failed', message=str(error)[:1000])
            if validation['status'] != 'succeeded':
                report['status'] = 'failed'
                checkpoint('训练选参完成，但留出验证失败；已保留训练最优结果')
                return report
        report['status'] = 'completed'
        checkpoint(('搜索达到时间上限，' if timed_out else '') + f'已评估 {len(report["trials"])} 次，{report["completed_trials"]} 次有效；已保留最佳训练回测')
    except InterruptedError:
        report['status'] = 'cancelled'
        checkpoint('用户中止了操作；已保留完成的试验')
    except Exception as error:
        report['status'] = 'failed'
        checkpoint(str(error)[:1000])
        raise
    return report


def main():
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    optimize(Path(sys.argv[2]), sys.argv[1], stop)


if __name__ == '__main__':
    main()
