import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
from common import TZ, STOCK_SESSIONS, in_session, timestamp, bar, quote, instrument


class SessionsTest(unittest.TestCase):
    def setUp(self):
        start = datetime(2026, 10, 12).date()
        self.calendar = {(start + timedelta(days=i)).isoformat(): (start + timedelta(days=i)).weekday() < 5 for i in range(14)}

    def check(self, moment, expected, sessions=STOCK_SESSIONS, before=5, after=10):
        self.assertEqual(in_session(datetime.fromisoformat(moment).replace(tzinfo=TZ), sessions, self.calendar, before, after), expected)

    def test_stock_open_and_lunch_offsets(self):
        for moment, expected in [('09:24:59', False), ('09:25:00', True), ('11:40:00', True), ('11:40:01', False), ('12:55:00', True), ('15:10:00', True), ('15:10:01', False)]:
            self.check('2026-10-16T' + moment, expected)

    def test_weekend_and_missing_calendar_fail_closed(self):
        self.check('2026-10-17T10:00:00', False)
        self.calendar.clear()
        self.check('2026-10-16T10:00:00', False)

    def test_friday_night_and_saturday_continuation(self):
        night = {'day': [], 'night': [['21:00:00', '26:30:00']]}
        self.check('2026-10-16T20:55:00', True, night)
        self.check('2026-10-17T02:40:00', True, night)
        self.check('2026-10-17T02:40:01', False, night)
        self.check('2026-10-18T21:00:00', False, night)

    def test_holiday_eve_night_is_closed(self):
        self.calendar['2026-10-19'] = False
        self.check('2026-10-16T21:30:00', False, {'day': [], 'night': [['21:00:00', '02:30:00']]})

    def test_split_midnight_session(self):
        sessions = {'day': [], 'night': [['21:00:00', '24:00:00'], ['00:00:00', '02:30:00']]}
        self.check('2026-10-17T01:30:00', True, sessions)
        self.check('2026-10-19T01:30:00', False, sessions)

    def test_exchange_timezone_is_explicit(self):
        self.assertEqual(timestamp('2026-10-16 09:30:00'), datetime(2026, 10, 16, 9, 30, tzinfo=TZ).timestamp())
        self.assertIsNone(timestamp('09:30:00'))
        self.assertIsNone(timestamp('NaT'))

    def test_missing_prices_are_never_zero_candles(self):
        self.assertIsNone(bar('SSE.000852', 60, 1, dict(open=1, high=float('nan'), low=1, close=1)))
        self.assertIsNone(quote('SSE.000852', None, {'last': 10}, {}))
        self.assertIsNone(bar('SSE.000852', 60, 1, dict(open=5, high=2, low=1, close=4)))

    def test_catalog_nan_metadata_is_sanitized(self):
        import json
        value = instrument('SSE.000852', '中证1000', product=float('nan'), underlying=float('nan'))
        json.dumps(value, allow_nan=False)
        self.assertEqual(value['underlying'], '')


if __name__ == '__main__':
    unittest.main()
