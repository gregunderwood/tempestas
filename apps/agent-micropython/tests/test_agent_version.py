import sys
from types import ModuleType

import pytest

from agent_version import UNSTAMPED_VERSION, read_agent_version
from test_node_agent import AgentUnderTest

STAMP_MODULE = "deployed_version"


@pytest.fixture
def unstamped(monkeypatch):
    # None in sys.modules makes the import fail, as it does on a board the script never stamped.
    monkeypatch.setitem(sys.modules, STAMP_MODULE, None)


@pytest.fixture
def stamped_as(monkeypatch):
    def stamp(agent_version):
        module = ModuleType(STAMP_MODULE)
        module.AGENT_VERSION = agent_version
        monkeypatch.setitem(sys.modules, STAMP_MODULE, module)

    return stamp


def test_an_unstamped_board_says_so(unstamped):
    assert read_agent_version() == UNSTAMPED_VERSION


def test_a_deployed_board_reports_the_stamped_version(stamped_as):
    stamped_as("1.0.3")
    assert read_agent_version() == "1.0.3"


def test_hello_carries_the_stamped_version(stamped_as):
    stamped_as("1.0.3")
    node = AgentUnderTest()
    node.agent.announce()
    hello = node.publisher.messages[1]
    assert hello.payload["agentVersion"] == "1.0.3"
