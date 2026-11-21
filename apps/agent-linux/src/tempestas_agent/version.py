AGENT_NAME = "agent-linux"
UNSTAMPED_VERSION = "0.0.0+dev"


def read_agent_version() -> str:
    try:
        # Written on the host by tools/deploy-agent-linux.sh, so it never exists in a checkout.
        from tempestas_agent.deployed_version import AGENT_VERSION
    except ImportError:
        return UNSTAMPED_VERSION
    return AGENT_VERSION
