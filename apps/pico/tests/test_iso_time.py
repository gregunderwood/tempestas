from datetime import UTC, date, datetime

from iso_time import count_days_since_epoch, format_iso, is_clock_set, parse_iso


def test_reads_the_server_toisostring_form_dropping_the_milliseconds():
    expected = int(datetime(2026, 11, 20, 23, 18, 16, tzinfo=UTC).timestamp())
    assert parse_iso("2026-11-20T23:18:16.282Z") == expected


def test_stays_in_integers_because_the_pico_floats_are_32_bit():
    fifteen_seconds_apart = [parse_iso("2026-11-20T23:18:16.282Z"), parse_iso("2026-11-20T23:18:31Z")]
    assert all(type(seconds) is int for seconds in fifteen_seconds_apart)
    assert fifteen_seconds_apart[1] - fifteen_seconds_apart[0] == 15


def test_reads_a_utc_offset_and_whole_seconds():
    expected = int(datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC).timestamp())
    assert parse_iso("2026-01-02T03:04:05+00:00") == expected


def test_refuses_anything_it_cannot_read_as_utc():
    for text in [
        None,
        42,
        "",
        "2026-11-20",
        "2026-11-20T23:18:16-07:00",
        "not a time at allZ",
        "2026/11/20T23:18:16Z",
        "2026-11-20T23:18:16.Z",
        "2026-11-20T23:18:16.2x2Z",
        "2026-11-20T23:18:1.5Z",
        "2026-11-2 T12:00:00Z",
        "2026-11-20T-1:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-11-20T24:00:00Z",
        "2026-11-20T23:60:00Z",
    ]:
        assert parse_iso(text) is None


def test_counts_days_exactly_across_leap_years_and_centuries():
    epoch = date(1970, 1, 1)
    for year, month, day in [(1970, 1, 1), (2000, 2, 29), (2024, 12, 31), (2100, 3, 1), (2026, 11, 20)]:
        assert count_days_since_epoch(year, month, day) == (date(year, month, day) - epoch).days


def test_formats_utc_with_a_z():
    assert format_iso(datetime(2026, 11, 20, 23, 18, 16, tzinfo=UTC).timestamp()) == "2026-11-20T23:18:16Z"


def test_knows_an_unset_clock_from_a_set_one():
    assert not is_clock_set(0)
    assert is_clock_set(datetime(2026, 11, 20, tzinfo=UTC).timestamp())
