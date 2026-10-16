import time
from datetime import datetime
from common import TZ, STOCK_SESSIONS, emit, in_session


def run(config):
    if config['engine'] == 'tdx':
        from tdx_provider import Provider
    else:
        from tushare_provider import Provider
    provider = Provider(config)
    try:
        provider.catalog()
        emit('catalog_complete')
        first = True
        while True:
            now = datetime.now(TZ)
            calendar = provider.calendar(now.date())
            active = in_session(now, STOCK_SESSIONS, calendar, config['beforeOpenMinutes'], config['afterCloseMinutes'])
            symbols = config['symbols']
            if symbols and (first or active):
                # Initial bounded backfill is allowed outside market hours.
                provider.poll(symbols, first)
                first = False
            state = 'syncing' if active and symbols else 'closed' if symbols else 'idle'
            message = '批量行情同步中' if state == 'syncing' else '休市，等待下个同步窗口' if symbols else '添加自选后自动订阅'
            endpoint = getattr(provider, 'connection_label', '')
            emit('status', state=state, message=f'{message} · {endpoint}' if endpoint else message, active=len(symbols) if active else 0)
            time.sleep(config['pollSeconds'])
    finally:
        provider.close()
