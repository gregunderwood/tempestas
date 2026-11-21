from __future__ import annotations

import sys
import tomllib
from pathlib import Path
from types import ModuleType

import pytest

from tempestas_agent.version import read_agent_version, read_package_version
from test_agent import make_agent

STAMP_MODULE = "tempestas_agent.deployed_version"
PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


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


def test_the_package_version_is_the_one_in_pyproject():
    project_version = tomllib.loads(PYPROJECT.read_text())["project"]["version"]
    assert read_package_version() == project_version


def test_an_agent_not_deployed_by_the_script_says_so(unstamped):
    assert read_agent_version() == f"{read_package_version()}+dev"


def test_a_deployed_agent_reports_the_stamped_commit(stamped_as):
    stamped_as("0.1.0+861cde6")
    assert read_agent_version() == "0.1.0+861cde6"


def test_hello_carries_the_stamped_version(stamped_as):
    stamped_as("0.1.0+861cde6-dirty")
    agent, _ = make_agent()
    assert agent.hello_payload()["agentVersion"] == "0.1.0+861cde6-dirty"
