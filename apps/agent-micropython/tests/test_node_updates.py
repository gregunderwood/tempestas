import pytest

from fakes import FakeInstaller
from iso_time import format_iso
from node_updates import ANOTHER_UPDATE_IN_PROGRESS, HELLO_REPEAT_MILLISECONDS
from slots import SlotStore
from test_node_agent import CONTROLLER, NODE_ID, AgentUnderTest
from update_gate import GATE_MILLISECONDS

RUNNING_VERSION = "1.2.0"
NEW_VERSION = "1.2.1"
MILLISECONDS_PER_SECOND = 1000
HEARTBEAT_INTERVAL_SECONDS = 5


@pytest.fixture
def store(tmp_path):
    store = SlotStore(str(tmp_path))
    store.write({"active": "a", "pending": None, "outcome": None})
    return store


def start_new_slot_on_its_gate(store):
    store.start_pending("b", "update-1", NEW_VERSION)
    node = AgentUnderTest(store=store)
    node.agent.agent_version = NEW_VERSION
    return node


def bring_online(node):
    node.agent.announce()
    node.deliver("server", {"state": "online"}, is_retained=True)
    node.agent.tend_update(True)


def heartbeat_naming(node, accepted_version):
    node.deliver(
        "/control/heartbeat", {"controller": CONTROLLER, "epoch": 1, "agentVersion": accepted_version}
    )


def run_connected_for(node, seconds):
    for _ in range(seconds):
        node.clock.advance_seconds(1)
        node.agent.tend_update(True)


def send_update(node, **overrides):
    body = {
        "schema": "update/1",
        "node": NODE_ID,
        "ts": format_iso(node.clock.epoch_seconds()),
        "id": "update-1",
        "issuedBy": CONTROLLER,
        "expiresAt": format_iso(node.clock.epoch_seconds() + 300),
        "app": "agent-micropython",
        "version": NEW_VERSION,
        "manifestUrl": "http://elantris:7000/api/agent-releases/agent-micropython/1.2.1/manifest.json",
        "manifestSha256": "a" * 64,
    }
    body.update(overrides)
    node.deliver("/update", body)


def update_statuses(node):
    return [
        (message.payload["id"], message.payload["state"], message.payload.get("reason"))
        for message in node.publisher.on_topic("/update/status")
    ]


def count_hellos(node):
    return len(node.publisher.on_topic("/hello"))


def test_installs_an_update_from_the_bound_controller_and_restarts_into_it(store):
    node = AgentUnderTest(store=store)
    node.heartbeat()

    send_update(node)

    assert [state for _, state, _ in update_statuses(node)] == [
        "downloading",
        "verifying",
        "installing",
        "restarting",
    ]
    assert node.installer.installed_commands[0]["version"] == NEW_VERSION
    assert node.resets == [True]


def test_reports_a_failed_install_and_keeps_running(store):
    node = AgentUnderTest(store=store, installer=FakeInstaller(failure="only 10 bytes of flash are free"))
    node.heartbeat()

    send_update(node)

    assert update_statuses(node)[-1] == ("update-1", "failed", "only 10 bytes of flash are free")
    assert node.resets == []


def test_waits_for_a_bound_controller_before_taking_any_update(store):
    node = AgentUnderTest(store=store)
    send_update(node)
    assert update_statuses(node) == []
    assert node.installer.installed_commands == []


def test_answers_an_update_for_another_app_with_a_failed_status(store):
    node = AgentUnderTest(store=store)
    node.heartbeat()

    send_update(node, app="agent-linux")

    assert update_statuses(node) == [
        ("update-1", "failed", "update is for agent-linux, this node runs agent-micropython")
    ]


def test_raises_an_alarm_for_an_update_from_another_controller(store):
    node = AgentUnderTest(store=store)
    node.heartbeat()

    send_update(node, issuedBy="rogue")

    assert [alarm.payload["code"] for alarm in node.publisher.on_topic("/alarm")] == ["CONTROLLER_CONFLICT"]
    assert node.installer.installed_commands == []


def test_a_new_slot_refuses_another_update_until_its_gate_settles(store):
    node = start_new_slot_on_its_gate(store)
    node.heartbeat()

    send_update(node, id="update-2", version="1.2.2")

    assert update_statuses(node) == [("update-2", "failed", ANOTHER_UPDATE_IN_PROGRESS)]


def test_a_new_slot_is_kept_once_the_server_names_it_and_says_healthy(store):
    node = start_new_slot_on_its_gate(store)
    bring_online(node)

    heartbeat_naming(node, NEW_VERSION)

    assert store.read()["active"] == "b"
    assert update_statuses(node) == [("update-1", "healthy", None)]
    assert store.read()["outcome"] is None


def test_a_new_slot_says_hello_again_while_the_server_names_the_old_version(store):
    node = start_new_slot_on_its_gate(store)
    bring_online(node)

    heartbeat_naming(node, RUNNING_VERSION)
    assert count_hellos(node) == 1
    node.clock.advance_seconds(HELLO_REPEAT_MILLISECONDS // MILLISECONDS_PER_SECOND)
    heartbeat_naming(node, RUNNING_VERSION)

    assert count_hellos(node) == 2


def test_a_new_slot_the_server_never_takes_rolls_back_and_says_why(store):
    node = start_new_slot_on_its_gate(store)
    bring_online(node)

    for _ in range(GATE_MILLISECONDS // MILLISECONDS_PER_SECOND // HEARTBEAT_INTERVAL_SECONDS):
        heartbeat_naming(node, RUNNING_VERSION)
        run_connected_for(node, HEARTBEAT_INTERVAL_SECONDS)
        if node.resets:
            break

    assert node.resets == [True]
    state = store.read()
    assert (state["active"], state["pending"]) == ("a", None)
    assert state["outcome"]["state"] == "rolled-back"
    assert state["outcome"]["reason"] == (
        "the server did not accept 1.2.1's hello in 120s: it still names %s" % RUNNING_VERSION
    )


def test_a_new_slot_counts_gate_time_only_while_the_server_is_online(store):
    node = start_new_slot_on_its_gate(store)
    bring_online(node)
    node.deliver("server", {"state": "offline"})

    run_connected_for(node, GATE_MILLISECONDS // MILLISECONDS_PER_SECOND * 2)

    assert node.resets == []


def test_a_new_slot_counts_no_gate_time_while_the_broker_is_away(store):
    node = start_new_slot_on_its_gate(store)
    bring_online(node)

    for _ in range(GATE_MILLISECONDS // MILLISECONDS_PER_SECOND * 2):
        node.clock.advance_seconds(1)
        node.agent.tend_update(False)

    assert node.resets == []


def test_a_new_slot_passes_on_any_heartbeat_from_a_server_before_contract_1_2(store):
    node = start_new_slot_on_its_gate(store)
    bring_online(node)

    node.heartbeat()

    assert store.read()["active"] == "b"


def test_the_previous_slot_reports_the_roll_back_once_the_server_is_online(store):
    store.start_pending("b", "update-1", NEW_VERSION)
    store.abandon_pending("1.2.1 did not come up healthy in 3 boots")
    node = AgentUnderTest(store=store)

    node.agent.announce()
    assert update_statuses(node) == []
    node.deliver("server", {"state": "online"}, is_retained=True)
    node.deliver("server", {"state": "online"})

    assert update_statuses(node) == [("update-1", "rolled-back", "1.2.1 did not come up healthy in 3 boots")]
    assert store.read()["outcome"] is None


def test_an_outcome_is_kept_while_the_server_is_offline(store):
    store.start_pending("b", "update-1", NEW_VERSION)
    store.abandon_pending("gone")
    node = AgentUnderTest(store=store)

    node.deliver("server", {"state": "offline"}, is_retained=True)

    assert update_statuses(node) == []
    assert store.read()["outcome"]["state"] == "rolled-back"
