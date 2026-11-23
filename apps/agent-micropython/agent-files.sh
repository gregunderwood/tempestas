# Inside the agent, so a change to it raises this agent's version and no other's; the deploy and the bundler both read it.

MICROPYTHON_AGENT_CODE=(
  main.py node_runtime.py node_agent.py tempestas_mqtt.py command_guard.py contract.py agent_version.py
  iso_time.py relay_lines.py ds18b20_probes.py
)
# Per node, so never in a bundle: settings.py names the node and its pins, credentials.py holds the Wi-Fi password.
MICROPYTHON_NODE_CONFIG=(settings.py credentials.py)
MICROPYTHON_BOARDS_DIRECTORY=boards
MICROPYTHON_AGENT_VERSION_STAMP=deployed_version.py
