AGENT_NAME = "agent-micropython"
UNSTAMPED_VERSION = "0.0.0+dev"


def read_agent_version():
    try:
        # Copied onto the board by tools/deploy-agent-micropython.sh, so it never exists in a checkout.
        from deployed_version import AGENT_VERSION
    except ImportError:
        return UNSTAMPED_VERSION
    return AGENT_VERSION
