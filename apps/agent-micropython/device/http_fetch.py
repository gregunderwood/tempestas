"""An HTTP/1.0 GET streamed in chunks, so no file has to fit in RAM and the watchdog is fed between them."""

DEFAULT_PORTS = {"http": 80, "https": 443}
# Under the 8 s watchdog, which is fed between socket operations.
SOCKET_TIMEOUT_SECONDS = 5
FETCH_DEADLINE_MILLISECONDS = 30000
CHUNK_BYTES = 1024
MAX_HEADER_LINE_BYTES = 1024
MAX_HEADER_LINES = 32
HTTP_OK = 200


class FetchFailed(Exception):
    pass


def split_url(url):
    scheme, separator, rest = url.partition("://")
    if not separator or scheme not in DEFAULT_PORTS:
        raise FetchFailed("%s is not an http(s) URL" % url)
    authority, slash, path = rest.partition("/")
    host, colon, port_text = authority.partition(":")
    if not host or (colon and not port_text.isdigit()):
        raise FetchFailed("%s has no usable host" % describe_without_query(url))
    port = int(port_text) if colon else DEFAULT_PORTS[scheme]
    return scheme, host, port, slash + path if slash else "/"


def describe_without_query(url):
    # The query may hold a signature, and reasons are published.
    return url.partition("?")[0]


def build_request(host, target):
    # HTTP/1.0, so the server answers with a plain body instead of chunks.
    return ("GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" % (target, host)).encode()


class HttpFetcher:
    def __init__(self, socket_module, tls_module, feed_watchdog, clock):
        self.socket_module = socket_module
        self.tls_module = tls_module
        self.feed_watchdog = feed_watchdog
        self.clock = clock

    def fetch(self, url, write_chunk, max_bytes):
        try:
            self.fetch_or_raise(url, write_chunk, max_bytes)
        except OSError as error:
            raise FetchFailed("could not fetch %s: %r" % (describe_without_query(url), error)) from error

    def fetch_or_raise(self, url, write_chunk, max_bytes):
        scheme, host, port, target = split_url(url)
        started_ticks = self.clock.ticks()
        stream = self.open_stream(scheme, host, port)
        try:
            stream.write(build_request(host, target))
            require_ok_status(stream.readline(), url)
            body_length = read_body_length(stream, url)
            self.copy_body(stream, write_chunk, body_length, max_bytes, started_ticks, url)
        finally:
            stream.close()

    def open_stream(self, scheme, host, port):
        address = self.socket_module.getaddrinfo(host, port)[0][-1]
        connection = self.socket_module.socket()
        connection.settimeout(SOCKET_TIMEOUT_SECONDS)
        try:
            self.feed_watchdog()
            connection.connect(address)
            if scheme == "https":
                # Unverified: the board holds no CA store, and every byte is checked against a pinned sha256.
                return self.tls_module.wrap_socket(connection, server_hostname=host)
        except BaseException:
            connection.close()
            raise
        return connection

    def copy_body(self, stream, write_chunk, body_length, max_bytes, started_ticks, url):
        if body_length is not None and body_length > max_bytes:
            raise FetchFailed("%s is larger than %d bytes" % (describe_without_query(url), max_bytes))
        copied_bytes = 0
        while body_length is None or copied_bytes < body_length:
            self.feed_watchdog()
            if self.clock.elapsed_since(started_ticks) > FETCH_DEADLINE_MILLISECONDS:
                raise FetchFailed(
                    "%s took longer than %d s"
                    % (describe_without_query(url), FETCH_DEADLINE_MILLISECONDS // 1000)
                )
            chunk = stream.read(CHUNK_BYTES)
            if not chunk:
                break
            copied_bytes += len(chunk)
            if copied_bytes > max_bytes:
                raise FetchFailed("%s is larger than %d bytes" % (describe_without_query(url), max_bytes))
            write_chunk(chunk)
        if body_length is not None and copied_bytes < body_length:
            raise FetchFailed(
                "%s ended after %d of %d bytes" % (describe_without_query(url), copied_bytes, body_length)
            )


def require_ok_status(status_line, url):
    parts = status_line.split()
    if len(parts) < 2 or not parts[1].isdigit():
        raise FetchFailed("%s sent no HTTP status" % describe_without_query(url))
    status = int(parts[1])
    if status != HTTP_OK:
        raise FetchFailed("%s answered %d" % (describe_without_query(url), status))


def read_body_length(stream, url):
    body_length = None
    for _ in range(MAX_HEADER_LINES):
        line = stream.readline()
        if not line or line in (b"\r\n", b"\n"):
            return body_length
        if len(line) > MAX_HEADER_LINE_BYTES:
            raise FetchFailed("%s sent a header line too long to read" % describe_without_query(url))
        name, _, value = line.decode().partition(":")
        name = name.strip().lower()
        value = value.strip()
        if name == "transfer-encoding" and value.lower() != "identity":
            raise FetchFailed(
                "%s sent a %s body, which this node cannot read" % (describe_without_query(url), value)
            )
        if name == "content-length" and value.isdigit():
            body_length = int(value)
    raise FetchFailed("%s sent more than %d header lines" % (describe_without_query(url), MAX_HEADER_LINES))
