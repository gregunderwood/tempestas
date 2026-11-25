AGENT_NAME = "agent-linux"
UNSTAMPED_VERSION = "0.0.0+dev"


def read_agent_version() -> str:
    try:
        # Stamped by the deploy or the package build, so it never exists in a checkout.
        from tempestas_agent.deployed_version import AGENT_VERSION
    except ImportError:
        return UNSTAMPED_VERSION
    return AGENT_VERSION


def is_installed_from_a_package() -> bool:
    try:
        from tempestas_agent.deployed_version import INSTALLED_FROM_A_PACKAGE
    except ImportError:
        return False
    return INSTALLED_FROM_A_PACKAGE
