"""ISO-8601 in UTC, by arithmetic: MicroPython has no datetime, and mktime is local time."""

import time

SECONDS_PER_MINUTE = 60
SECONDS_PER_HOUR = 3600
SECONDS_PER_DAY = 86400
FIRST_YEAR_OF_A_SET_CLOCK = 2024
UTC_SUFFIXES = ("Z", "+00:00")


def format_iso(epoch_seconds):
    year, month, day, hour, minute, second = time.gmtime(int(epoch_seconds))[:6]
    return "%04d-%02d-%02dT%02d:%02d:%02dZ" % (year, month, day, hour, minute, second)


def is_clock_set(epoch_seconds):
    return time.gmtime(int(epoch_seconds))[0] >= FIRST_YEAR_OF_A_SET_CLOCK


def parse_iso(text):
    """Epoch seconds for a UTC ISO-8601 string such as the server's toISOString(), else None."""
    if not isinstance(text, str):
        return None
    without_zone = strip_utc_suffix(text)
    if without_zone is None or len(without_zone) < 19:
        return None
    try:
        year = int(without_zone[0:4])
        month = int(without_zone[5:7])
        day = int(without_zone[8:10])
        hour = int(without_zone[11:13])
        minute = int(without_zone[14:16])
        second = float(without_zone[17:])
    except ValueError:
        return None
    if not has_iso_separators(without_zone):
        return None
    days = count_days_since_epoch(year, month, day)
    return days * SECONDS_PER_DAY + hour * SECONDS_PER_HOUR + minute * SECONDS_PER_MINUTE + second


def strip_utc_suffix(text):
    for suffix in UTC_SUFFIXES:
        if text.endswith(suffix):
            return text[: len(text) - len(suffix)]
    return None


def has_iso_separators(text):
    return text[4] == "-" and text[7] == "-" and text[10] == "T" and text[13] == ":" and text[16] == ":"


def count_days_since_epoch(year, month, day):
    # Howard Hinnant's days_from_civil: exact for every Gregorian date, with no calendar library.
    shifted_year = year - 1 if month <= 2 else year
    era = shifted_year // 400
    year_of_era = shifted_year - era * 400
    shifted_month = month - 3 if month > 2 else month + 9
    day_of_year = (153 * shifted_month + 2) // 5 + day - 1
    day_of_era = year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year
    return era * 146097 + day_of_era - 719468
