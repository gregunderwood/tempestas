from __future__ import annotations

import sys
from types import ModuleType

import pytest

from tempestas_agent.version import UNSTAMPED_VERSION, read_agent_version
from test_agent import make_agent

STAMP_MODULE = "tempestas_agent.deployed_version"


@pytest.fixture
def unstamped(monkeypatch):
    # None in sys.modules makes the import fail, as it does in any checkout.
    monkeypatch.setitem(sys.modules, STAMP_MODULE, None)


@pytest.fixture
def stamped_as(monkeypatch):
    def stamp(agent_version: str) -> None:
        module = ModuleType(STAMP_MODULE)
        module.AGENT_VERSION = agent_version
        monkeypatch.setitem(sys.modules, STAMP_MODULE, module)

    return stamp


def test_an_agent_not_deployed_by_the_script_says_so(unstamped):
    assert read_agent_version() == UNSTAMPED_VERSION


def test_a_deployed_agent_reports_the_stamped_version(stamped_as):
    stamped_as("1.0.3")
    assert read_agent_version() == "1.0.3"


def test_hello_carries_the_stamped_version(stamped_as):
    stamped_as("1.0.4-dev+861cde6.dirty")
    agent, _ = make_agent()
    assert agent.hello_payload()["agentVersion"] == "1.0.4-dev+861cde6.dirty"


def test_hello_names_the_app_and_the_contract_minor():
    agent, _ = make_agent()
    hello = agent.hello_payload()
    assert hello["agentName"] == "agent-linux"
    assert hello["capabilities"]["contractMinor"] == 0
