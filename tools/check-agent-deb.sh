#!/usr/bin/env bash
# tools/check-agent-deb.sh <tempestas-agent .deb>
# Installs the package in clean bookworm and trixie containers, checks its user, unit and imports, then removes it.

set -euo pipefail

PACKAGE_FILE="$(realpath "$1")"
DEBIAN_RELEASES=(bookworm trixie)

check_in_container() {
  local debian_release="$1"
  echo "Checking $(basename "$PACKAGE_FILE") on Debian $debian_release" >&2
  docker run --rm --volume "$PACKAGE_FILE:/tmp/tempestas-agent.deb:ro" "debian:$debian_release" bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    export PYTHONPATH=/usr/lib/tempestas/agent:/usr/lib/tempestas/agent/vendor
    apt-get update -qq
    apt-get install -y -qq /tmp/tempestas-agent.deb >/dev/null
    getent passwd tempestas >/dev/null
    test -f /usr/lib/systemd/system/tempestas-agent.service
    test -d /etc/tempestas
    test ! -e /etc/tempestas/agent.toml
    cd /
    python3 -c "
import sys
import paho.mqtt.client, smbus2
from tempestas_agent import agent
from tempestas_agent.version import is_installed_from_a_package, read_agent_version
assert is_installed_from_a_package()
print(\"  Python\", sys.version.split()[0], \"imports the agent, which reports\", read_agent_version())
"
    python3 -m tempestas_agent --help >/dev/null
    apt-get remove -y -qq tempestas-agent >/dev/null
    test ! -e /usr/lib/tempestas/agent
  '
}

for debian_release in "${DEBIAN_RELEASES[@]}"; do
  check_in_container "$debian_release"
done
echo "$(basename "$PACKAGE_FILE") installs, imports and removes cleanly on ${DEBIAN_RELEASES[*]}" >&2
