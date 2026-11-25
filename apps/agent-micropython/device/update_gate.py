"""The Linux agent's health gate, timed in ticks: a new slot passes once the server names its version."""

import contract

GATE_MILLISECONDS = 120000
MILLISECONDS_PER_SECOND = 1000


def describe_what_server_accepted(accepted_version):
    if accepted_version is None:
        return "it has accepted no hello from this node"
    if not isinstance(accepted_version, str) or not accepted_version:
        return "it named %r, which is not a version" % (accepted_version,)
    return "it still names %s" % accepted_version


class HealthGate:
    """Counts only time with the broker connected and the server online: an outage is no verdict."""

    def __init__(self, clock, version):
        self.clock = clock
        self.version = version
        self.hello_version = None
        self.has_server_accepted_hello = False
        self.has_heard_versions_named = False
        self.last_refusal = None
        self.watched_milliseconds = 0
        self.last_tended_ticks = None

    def has_said_hello(self):
        return self.hello_version is not None

    def note_hello(self, agent_version):
        self.hello_version = agent_version

    def note_heartbeat(self, heartbeat):
        accepted_version_field = contract.HEARTBEAT_ACCEPTED_VERSION_FIELD
        if accepted_version_field in heartbeat:
            self.has_heard_versions_named = True
        # Before our hello, a heartbeat proves only the broker.
        if not self.has_said_hello():
            return
        if accepted_version_field in heartbeat:
            self.note_named_version(heartbeat[accepted_version_field])
        else:
            self.note_heartbeat_without_a_version()

    def note_named_version(self, accepted_version):
        if accepted_version == self.hello_version:
            self.has_server_accepted_hello = True
        else:
            self.last_refusal = describe_what_server_accepted(accepted_version)

    def note_heartbeat_without_a_version(self):
        # Only a pre-1.2 server omits the version, so once one was named this proves nothing.
        if self.has_heard_versions_named:
            self.last_refusal = "it stopped naming the version it accepted"
        else:
            self.has_server_accepted_hello = True

    def count_time(self, is_watching):
        now_ticks = self.clock.ticks()
        if is_watching and self.last_tended_ticks is not None:
            self.watched_milliseconds += self.clock.elapsed_since(self.last_tended_ticks)
        self.last_tended_ticks = now_ticks if is_watching else None

    def is_passed(self):
        return self.has_server_accepted_hello

    def is_refused(self):
        return not self.is_passed() and self.last_refusal is not None

    def is_overdue(self):
        return not self.is_passed() and self.watched_milliseconds >= GATE_MILLISECONDS

    def describe_failure(self):
        gate_seconds = GATE_MILLISECONDS // MILLISECONDS_PER_SECOND
        refusal = self.last_refusal
        if refusal is None:
            return "%s heard no heartbeat in %ds with the server online" % (self.version, gate_seconds)
        return "the server did not accept %s's hello in %ds: %s" % (self.version, gate_seconds, refusal)
