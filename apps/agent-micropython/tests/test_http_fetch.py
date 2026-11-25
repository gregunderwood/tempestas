import io

import pytest

from fakes import FakeClock
from http_fetch import (
    CHUNK_BYTES,
    FETCH_DEADLINE_MILLISECONDS,
    FetchFailed,
    HttpFetcher,
    split_url,
)

MANIFEST_URL = "http://elantris:7000/api/agent-releases/agent-micropython/1.2.1/manifest.json"
BODY = b'{"app": "agent-micropython"}'
MAX_BYTES = 1024


def build_response(body, status_line=b"HTTP/1.1 200 OK", headers=None):
    header_lines = headers if headers is not None else [b"Content-Length: %d" % len(body)]
    return b"\r\n".join([status_line, *header_lines, b"", b""]) + body


class FakeConnection:
    def __init__(self, response, clock=None, seconds_per_read=0):
        self.response = io.BytesIO(response)
        self.clock = clock
        self.seconds_per_read = seconds_per_read
        self.sent = b""
        self.address = None
        self.is_closed = False

    def settimeout(self, seconds):
        self.timeout_seconds = seconds

    def connect(self, address):
        self.address = address

    def write(self, data):
        self.sent += data

    def readline(self):
        return self.response.readline()

    def read(self, size):
        if self.clock is not None:
            self.clock.advance_seconds(self.seconds_per_read)
        return self.response.read(size)

    def close(self):
        self.is_closed = True


class FakeSocketModule:
    def __init__(self, connection):
        self.connection = connection
        self.looked_up = []

    def getaddrinfo(self, host, port):
        self.looked_up.append((host, port))
        return [(2, 1, 0, "", (host, port))]

    def socket(self):
        return self.connection


class FakeTls:
    def __init__(self):
        self.wrapped_for = None

    def wrap_socket(self, connection, server_hostname):
        self.wrapped_for = server_hostname
        return connection


class Fetch:
    def __init__(self, response, seconds_per_read=0):
        self.clock = FakeClock()
        self.connection = FakeConnection(response, self.clock, seconds_per_read)
        self.socket_module = FakeSocketModule(self.connection)
        self.tls = FakeTls()
        self.feeds = 0
        self.fetcher = HttpFetcher(self.socket_module, self.tls, self.feed, self.clock)
        self.received = bytearray()

    def feed(self):
        self.feeds += 1

    def __call__(self, url=MANIFEST_URL, max_bytes=MAX_BYTES):
        self.fetcher.fetch(url, self.received.extend, max_bytes)
        return bytes(self.received)


def test_fetches_a_body_with_an_http_1_0_request():
    fetch = Fetch(build_response(BODY))

    assert fetch() == BODY
    assert fetch.socket_module.looked_up == [("elantris", 7000)]
    assert fetch.connection.sent.startswith(
        b"GET /api/agent-releases/agent-micropython/1.2.1/manifest.json HTTP/1.0\r\nHost: elantris\r\n"
    )
    assert fetch.connection.is_closed


def test_streams_a_large_body_in_chunks_feeding_the_watchdog_between_them():
    body = bytes(range(256)) * 12
    fetch = Fetch(build_response(body))

    assert fetch(max_bytes=len(body)) == body
    assert fetch.feeds > len(body) // CHUNK_BYTES


def test_reads_to_the_end_when_the_server_gives_no_length():
    fetch = Fetch(build_response(BODY, headers=[b"Content-Type: application/json"]))
    assert fetch() == BODY


def test_refuses_a_chunked_body():
    fetch = Fetch(build_response(BODY, headers=[b"Transfer-Encoding: chunked"]))
    with pytest.raises(FetchFailed, match="chunked"):
        fetch()


def test_refuses_an_answer_other_than_200():
    fetch = Fetch(build_response(b"", status_line=b"HTTP/1.1 404 Not Found"))
    with pytest.raises(FetchFailed, match="answered 404"):
        fetch()


def test_refuses_a_body_larger_than_allowed_before_reading_it():
    fetch = Fetch(build_response(BODY))
    with pytest.raises(FetchFailed, match="larger than 4 bytes"):
        fetch(max_bytes=4)
    assert fetch.received == b""


def test_refuses_a_body_that_ends_early():
    fetch = Fetch(build_response(BODY, headers=[b"Content-Length: %d" % (len(BODY) + 10)]))
    with pytest.raises(FetchFailed, match="ended after"):
        fetch()


def test_gives_up_on_a_trickle_past_the_deadline():
    body = b"x" * (CHUNK_BYTES * 4)
    seconds_per_read = FETCH_DEADLINE_MILLISECONDS // 1000 // 2
    fetch = Fetch(build_response(body), seconds_per_read=seconds_per_read)
    with pytest.raises(FetchFailed, match="took longer"):
        fetch(max_bytes=len(body))


def test_names_a_socket_error_without_the_query():
    fetch = Fetch(build_response(BODY))

    def refuse(address):
        raise OSError(111)

    fetch.connection.connect = refuse
    with pytest.raises(FetchFailed) as failure:
        fetch(MANIFEST_URL + "?signature=secret")
    assert "secret" not in str(failure.value)
    assert fetch.connection.is_closed


def test_wraps_https_in_tls_for_the_named_host():
    fetch = Fetch(build_response(BODY))
    fetch("https://releases.example/manifest.json")
    assert fetch.tls.wrapped_for == "releases.example"
    assert fetch.socket_module.looked_up == [("releases.example", 443)]


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://elantris:7000/a/b.json?x=1", ("http", "elantris", 7000, "/a/b.json?x=1")),
        ("http://elantris", ("http", "elantris", 80, "/")),
        ("https://host/path", ("https", "host", 443, "/path")),
    ],
)
def test_splits_a_url_into_what_the_socket_needs(url, expected):
    assert split_url(url) == expected


@pytest.mark.parametrize("url", ["ftp://host/file", "http:///path", "http://host:port/path", "nonsense"])
def test_refuses_a_url_it_cannot_fetch(url):
    with pytest.raises(FetchFailed):
        split_url(url)
