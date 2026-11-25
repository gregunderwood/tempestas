# Inside the agent, so a change to it raises this agent's version and no other's; the deploy and the bundler both read it.

# At the root and never in a bundle: only a USB deploy replaces the code that rolls a bad update back.
MICROPYTHON_BOOTLOADER=(main.py bootloader.py slots.py)
# In a slot, so an update fills the slot that is not running.
MICROPYTHON_AGENT_CODE=(
  node_runtime.py node_agent.py tempestas_mqtt.py command_guard.py contract.py agent_version.py
  iso_time.py relay_lines.py ds18b20_probes.py http_fetch.py update_guard.py update_gate.py
  slot_installer.py node_updates.py
)
# Per node, so never in a bundle: settings.py names the node and its pins, credentials.py holds the Wi-Fi password.
MICROPYTHON_NODE_CONFIG=(settings.py credentials.py)
MICROPYTHON_BOARDS_DIRECTORY=boards
MICROPYTHON_AGENT_VERSION_STAMP=deployed_version.py
MICROPYTHON_BOARD_FILE=board.py
MICROPYTHON_USB_DEPLOY_SLOT=a
MICROPYTHON_SLOT_STATE=slots.json
