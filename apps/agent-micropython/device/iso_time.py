"""Integers only: the Pico's 32-bit floats step by 128 s near today's epoch seconds."""

import time

SECONDS_PER_MINUTE = 60
SECONDS_PER_HOUR = 3600
SECONDS_PER_DAY = 86400
FIRST_YEAR_OF_A_SET_CLOCK = 2024
UTC_SUFFIXES = ("Z", "+00:00")
ISO_SECONDS_LENGTH = len("2026-01-01T00:00:00")
SEPARATORS = ((4, "-"), (7, "-"), (10, "T"), (13, ":"), (16, ":"))
FRACTION_MARK = "."
DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
FEBRUARY = 2
DAYS_IN_A_LEAP_FEBRUARY = 29
YEARS_PER_ERA = 400
DAYS_PER_ERA = 146097
DAYS_FROM_YEAR_ZERO_MARCH_TO_EPOCH = 719468


class IsoField:
    def __init__(self, start, end, lowest, highest):
        self.start = start
        self.end = end
        self.lowest = lowest
        self.highest = highest


YEAR = IsoField(0, 4, 1970, 9999)
MONTH = IsoField(5, 7, 1, 12)
DAY = IsoField(8, 10, 1, 31)
HOUR = IsoField(11, 13, 0, 23)
MINUTE = IsoField(14, 16, 0, 59)
SECOND = IsoField(17, 19, 0, 59)
DATE_TIME_FIELDS = (YEAR, MONTH, DAY, HOUR, MINUTE, SECOND)


def format_iso(epoch_seconds):
    year, month, day, hour, minute, second = time.gmtime(int(epoch_seconds))[:6]
    return "%04d-%02d-%02dT%02d:%02d:%02dZ" % (year, month, day, hour, minute, second)


def is_clock_set(epoch_seconds):
    return time.gmtime(int(epoch_seconds))[0] >= FIRST_YEAR_OF_A_SET_CLOCK


def parse_iso(text):
    """Whole epoch seconds, fraction dropped, for a UTC ISO-8601 string such as toISOString(), else None."""
    if not isinstance(text, str):
        return None
    without_zone = strip_utc_suffix(text)
    if without_zone is None or len(without_zone) < ISO_SECONDS_LENGTH:
        return None
    if not has_iso_separators(without_zone) or not is_fraction_of_a_second(without_zone[ISO_SECONDS_LENGTH:]):
        return None
    values = [read_field(without_zone, field) for field in DATE_TIME_FIELDS]
    if None in values:
        return None
    year, month, day, hour, minute, second = values
    if day > count_days_in_month(year, month):
        return None
    days = count_days_since_epoch(year, month, day)
    return days * SECONDS_PER_DAY + hour * SECONDS_PER_HOUR + minute * SECONDS_PER_MINUTE + second


def strip_utc_suffix(text):
    for suffix in UTC_SUFFIXES:
        if text.endswith(suffix):
            return text[: len(text) - len(suffix)]
    return None


def read_field(text, field):
    digits = text[field.start : field.end]
    if not digits.isdigit():
        return None
    value = int(digits)
    return value if field.lowest <= value <= field.highest else None


def is_fraction_of_a_second(text):
    return text == "" or (text[0] == FRACTION_MARK and len(text) > 1 and text[1:].isdigit())


def has_iso_separators(text):
    return all(text[position] == separator for position, separator in SEPARATORS)


def count_days_in_month(year, month):
    if month == FEBRUARY and is_leap_year(year):
        return DAYS_IN_A_LEAP_FEBRUARY
    return DAYS_IN_MONTH[month - 1]


def is_leap_year(year):
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def count_days_since_epoch(year, month, day):
    # Howard Hinnant's days_from_civil: exact for every Gregorian date, with no calendar library.
    shifted_year = year - 1 if month <= 2 else year
    era = shifted_year // YEARS_PER_ERA
    year_of_era = shifted_year - era * YEARS_PER_ERA
    shifted_month = month - 3 if month > 2 else month + 9
    day_of_year = (153 * shifted_month + 2) // 5 + day - 1
    day_of_era = year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year
    return era * DAYS_PER_ERA + day_of_era - DAYS_FROM_YEAR_ZERO_MARCH_TO_EPOCH
