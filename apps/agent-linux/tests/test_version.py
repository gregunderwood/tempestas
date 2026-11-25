from __future__ import annotations

import sys
from types import ModuleType

import pytest

from tempestas_agent.version import (
    UNSTAMPED_VERSION,
    is_installed_from_a_package,
    read_agent_version,
)
from test_agent import make_agent

STAMP_MODULE = "tempestas_agent.deployed_version"


@pytest.fixture
def unstamped(monkeypatch):
    # None in sys.modules makes the import fail, as it does in any checkout.
    monkeypatch.setitem(sys.modules, STAMP_MODULE, None)


@pytest.fixture
def stamped_as(monkeypatch):
    def stamp(agent_version: str, is_packaged: bool | None = None) -> None:
        module = ModuleType(STAMP_MODULE)
        module.AGENT_VERSION = agent_version
        if is_packaged is not None:
            module.INSTALLED_FROM_A_PACKAGE = is_packaged
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
    assert hello["capabilities"]["contractMinor"] == 2


def test_only_a_package_stamp_says_it_came_from_a_package(stamped_as):
    stamped_as("1.0.3")
    assert not is_installed_from_a_package()
    stamped_as("1.0.3", is_packaged=True)
    assert is_installed_from_a_package()


def test_a_checkout_is_not_a_package(unstamped):
    assert not is_installed_from_a_package()
