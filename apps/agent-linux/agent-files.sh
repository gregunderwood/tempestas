# Sourced by tools/deploy-agent-linux.sh and tools/lib/agent-bundle.sh, so a bundle holds what a deploy ships.
# Inside the agent, so a change to the list raises this agent's version and no other's.

LINUX_AGENT_PATHS=(src tools nodes systemd pyproject.toml uv.lock agent.example.toml)
LINUX_AGENT_VERSION_STAMP=src/tempestas_agent/deployed_version.py
