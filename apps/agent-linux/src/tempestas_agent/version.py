from importlib.metadata import PackageNotFoundError, version

PACKAGE_NAME = "tempestas-agent"
UNKNOWN_PACKAGE_VERSION = "0.0.0"
UNSTAMPED_BUILD = "dev"


def read_agent_version() -> str:
    try:
        # Written on the host by tools/deploy-agent-linux.sh, so it never exists in a checkout.
        from tempestas_agent.deployed_version import AGENT_VERSION
    except ImportError:
        return f"{read_package_version()}+{UNSTAMPED_BUILD}"
    return AGENT_VERSION


def read_package_version() -> str:
    try:
        return version(PACKAGE_NAME)
    except PackageNotFoundError:
        return UNKNOWN_PACKAGE_VERSION
