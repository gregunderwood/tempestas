# Inside the agent, so a change to it raises this agent's version and no other's; the deploy and the bundler both read it.

LINUX_AGENT_PATHS=(src tools nodes systemd pyproject.toml uv.lock agent.example.toml)
LINUX_AGENT_VERSION_STAMP=src/tempestas_agent/deployed_version.py
