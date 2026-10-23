"""Exchange dates are supplied explicitly; holidays are never guessed."""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo


class TradingCalendar:
    def __init__(self, days: dict[str, bool], *, timezone='Asia/Shanghai', daily_close='15:00:00'):
        if any(type(opened) is not bool for opened in days.values()):
            raise ValueError('Calendar values must be explicit booleans')
        self.days = {date.fromisoformat(day): opened for day, opened in days.items()}
        self.timezone = ZoneInfo(timezone)
        self.daily_close = time.fromisoformat(daily_close)

    def _next(self, day: date) -> date:
        for _ in range(32):
            if day not in self.days:
                raise ValueError(f'Missing exchange calendar date: {day}')
            if self.days[day]:
                return day
            day += timedelta(days=1)
        raise ValueError('No trading date in calendar window')

    def trading_day(self, timestamp: float, *, futures=False) -> str:
        local = datetime.fromtimestamp(timestamp, self.timezone)
        day = local.date()
        if futures and local.hour >= 18:
            day += timedelta(days=1)
        # Friday's night session can continue into Saturday, for Monday's trading date.
        if futures and (local.hour >= 18 or local.hour < 6):
            return self._next(day).isoformat()
        if day not in self.days or not self.days[day]:
            raise ValueError(f'Missing or closed exchange calendar date: {day}')
        return day.isoformat()

    def bar_end(self, start: float, duration: int, *, futures=False) -> tuple[float, str]:
        day = self.trading_day(start, futures=futures)
        if duration == 86400:
            end = datetime.combine(date.fromisoformat(day), self.daily_close, self.timezone).timestamp()
        elif duration in (60, 180, 300, 900, 1800, 3600):
            end = start + duration
        else:
            raise ValueError('SDK supports minute/hour and daily bars; calendar-month bars are not execution bars')
        return end, day

    def to_dict(self):
        return {'days': {day.isoformat(): opened for day, opened in self.days.items()},
                'timezone': str(self.timezone), 'daily_close': self.daily_close.isoformat()}
